import { TextDecoder, TextEncoder } from 'util'
import * as vscode from 'vscode'
import * as net from 'net'

enum RequestType {
	Completions = 1,
	Signatures = 2,
	Diagnose = 3,
	Open = 4,
	Definition = 5,
	Information = 6,
	FindReferences = 7,
	WorkspaceSymbols = 8
}

const RECEIVE_BUFFER_SIZE = 10000000
const MESSAGE_HEADER_SIZE = 8
const MAX_MESSAGE_SIZE = RECEIVE_BUFFER_SIZE - MESSAGE_HEADER_SIZE

const BUFFERED_SOCKET_SLEEP_INTERVAL = 10

/**
 * Converts the specified number into four byte array
 */
function int32_to_bytes(value: number) {
	return new Uint8Array([ value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >> 24) & 0xFF ])
}

/**
 * Expects the specified byte array to have four bytes and converts them into a 32-bit number (little endian).
 */
function bytes_to_int32(bytes: Uint8Array, offset?: number) {
	offset = offset || 0
	return bytes[offset + 0] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
}

/**
 * Converts the specified bytes into UTF-8 string
 */
function bytes_to_string(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes)
}

function to_response(bytes: Uint8Array): DocumentAnalysisResponse {
	const response = JSON.parse(bytes_to_string(bytes))

	if (response.Status !== 0) {
		// Display the error message and throw an error
		vscode.window.showErrorMessage(response.Data)
		throw new Error('Received an error response from the compiler service')
	}

	return response
}

type ReceiveCallback = (bytes: Uint8Array) => void

class BufferedSocket {
	private socket: net.Socket
	private buffer: Uint8Array
	private position: number = 0

	private receivers: Map<number, ReceiveCallback> = new Map<number, ReceiveCallback>()
	private id: number = 0

	constructor(on_error: (error: Error) => void) {
		this.socket = new net.Socket({ writable: true, readable: true })
		this.buffer = new Uint8Array(RECEIVE_BUFFER_SIZE)

		this.socket.on('data', (data) => {
			// Add the received fragment
			data.copy(this.buffer, this.position)
			this.position += data.length

			this.on_data_received()
		})

		this.socket.on('error', on_error)
		this.socket.on('end', () => console.log('Compiler service connection is now closed'))
	}

	on_data_received() {
		// Wait for the size of the message to arrive
		if (this.position < MESSAGE_HEADER_SIZE) return

		const size = bytes_to_int32(this.buffer)
		const id = bytes_to_int32(this.buffer, 4)

		// Validate the size
		if (size < 0 || size > MAX_MESSAGE_SIZE) {
			this.position = 0 // Prepare for another message
			// TODO: Reconnect? The next bytes might contain garbage so recovering is very difficult without knowing the real message size.
			return
		}

		// Wait until the message is received
		const received = this.position - MESSAGE_HEADER_SIZE
		if (received < size) return

		// Move the overflowed bytes (start of another message) to the start
		this.buffer.copyWithin(0, MESSAGE_HEADER_SIZE + size, this.position)
		this.position -= MESSAGE_HEADER_SIZE + size

		const receiver = this.receivers.get(id)

		// Remove the receiver, since the message is now received
		this.receivers.delete(id)

		if (receiver !== undefined) {
			// Extract the message from the receive buffer
			const message = this.buffer.slice(MESSAGE_HEADER_SIZE, MESSAGE_HEADER_SIZE + size)
			receiver(message)
		}

		// If we received part of the next message, start processing it
		if (this.position > 0) this.on_data_received()
	}

	connect(port: number, host?: string) {
		return new Promise<void>((resolve, _) => {
			this.socket.connect(port, host || '127.0.0.1', () => resolve())
		})
	}

	receive(id: number): Promise<Uint8Array> {
		return new Promise((resolve, reject) => {
			this.receivers.set(id, resolve)
		})
	}

	send_bytes(data: Uint8Array) {
		const id = this.id++
		this.socket.write(Buffer.concat([ int32_to_bytes(data.length), int32_to_bytes(id), data ]))

		return this.receive(id)
	}

	send_string(value: string) {
		return this.send_bytes(new TextEncoder().encode(value))
	}
}

class CompilerService {
	private socket: BufferedSocket
	private port: number

	/**
	 * Creates a compiler service using the specified active socket and a port
	 */
	constructor(socket: BufferedSocket, port: number) {
		this.socket = socket
		this.port = port
	}

	/**
	 * Bundles the specified document with the specified position and sends it using the socket
	 * @param document Contents of the current document as a string
	 * @param position The current position inside the specified document
	 */
	public send(request: RequestType, document: vscode.TextDocument, position: vscode.Position) {
		const payload = JSON.stringify({ Type: request as number, Uri: document.uri.toString(true), Document: document.getText(), Position: { Line: position.line, Character: position.character } })
		return this.socket.send_string(payload)
	}

	public query(request: RequestType, query: string) {
		const payload = JSON.stringify({ Type: request as number, Uri: '', Document: '', Position: { Line: -1, Character: -1 }, Query: query })
		return this.socket.send_string(payload)
	}

	/**
	 * Sends a command to the service to open the specified folder
	 */
	public open(folder: string) {
		const payload = JSON.stringify({ Type: RequestType.Open as number, Uri: folder, Document: '', Position: { Line: -1, Character: -1 } })
		return this.socket.send_string(payload)
	}
}

class CompletionItemProvider implements vscode.CompletionItemProvider {
	private service: CompilerService

	/**
	 * Creates a completion item provider which attempts to give the user auto-completions, using the specified compiler service
	 */
	constructor(service: CompilerService) {
		this.service = service
	}

	public async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, _: vscode.CancellationToken) : Promise<vscode.CompletionItem[]> {
		const bytes = await this.service.send(RequestType.Completions, document, position)
		const response = to_response(bytes)

		const items = JSON.parse(response.Data) as { Identifier: string, Type: number }[]

		return items.map(i => new vscode.CompletionItem(i.Identifier, i.Type))
	}
}

class SignatureHelpProvider implements vscode.SignatureHelpProvider {
	private service: CompilerService

	/**
	 * Creates a function information provider which attempts to show the user function signatures, using the specified compiler service
	 */
	constructor(service: CompilerService) {
		this.service = service
	}

	public async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, _: vscode.CancellationToken) {
		const bytes = await this.service.send(RequestType.Signatures, document, position)
		const response = to_response(bytes)

		const items = JSON.parse(response.Data) as { Identifier: string, Documentation: string, Parameters: { Name: string, Documentation: string }[] }[]

		const signatures = items.map(i => {
			const signature = new vscode.SignatureInformation(i.Identifier, i.Documentation)
			signature.parameters = i.Parameters.map(i => new vscode.ParameterInformation(i.Name, i.Documentation))

			return signature
		})

		const result = new vscode.SignatureHelp()
		result.signatures = signatures
		result.activeParameter = 0
		result.activeSignature = 0

		return result
	}
}

class DefinitionProvider implements vscode.DefinitionProvider {
	private service: CompilerService

	/**
	 * Creates a definition provider which helps the user to locate definitions of symbols
	 */
	constructor(service: CompilerService) {
		this.service = service
	}

	public async provideDefinition(document: vscode.TextDocument, position: vscode.Position, _: vscode.CancellationToken) {
		const bytes = await this.service.send(RequestType.Definition, document, position)
		const response = to_response(bytes)

		const range = JSON.parse(response.Data) as DocumentRange
		const start = new vscode.Position(range.Start.Line, range.Start.Character)
		const end = new vscode.Position(range.End.Line, range.End.Character)

		return new vscode.Location(vscode.Uri.file(response.Path), new vscode.Range(start, end))
	}
}

class HoverProvider implements vscode.HoverProvider {
	private service: CompilerService

	/**
	 * Creates a definition provider which helps the user to locate definitions of symbols
	 */
	constructor(service: CompilerService) {
		this.service = service
	}

	public async provideHover(document: vscode.TextDocument, position: vscode.Position, _: vscode.CancellationToken) {
		const bytes = await this.service.send(RequestType.Information, document, position)
		const response = to_response(bytes)

		const markdown = new vscode.MarkdownString()
		markdown.appendCodeblock(JSON.parse(response.Data), 'vivid')

		return new vscode.Hover(markdown, undefined)
	}
}

class ReferenceProvider implements vscode.ReferenceProvider {
	private service: CompilerService

	/**
	 * Creates a definition provider which helps the user to locate all usages of a variable or a function
	 */
	constructor(service: CompilerService) {
		this.service = service
	}

	public async provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, _: vscode.CancellationToken) {
		const bytes = await this.service.send(RequestType.FindReferences, document, position)
		const response = to_response(bytes)

		const files = JSON.parse(response.Data) as FileDivider[]

		const locations: vscode.Location[] = []

		for (const file of files) {
			const uri = vscode.Uri.parse(file.File)
			const positions = JSON.parse(file.Data) as DocumentPosition[]

			for (const position of positions) {
				locations.push(new vscode.Location(uri, new vscode.Position(position.Line, position.Character)));
			}
		}

		return locations
	}
}

class WorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
	private service: CompilerService

	constructor(service: CompilerService) {
		this.service = service
	}

	public async provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
		const bytes = await this.service.query(RequestType.WorkspaceSymbols, query)
		const response = to_response(bytes)

		const files = JSON.parse(response.Data) as FileDivider[]
		const result = []

		for (const file of files) {
			const symbols = JSON.parse(file.Data)
			const uri = vscode.Uri.parse(file.File)

			for (const symbol of symbols) {
				const position = to_internal_position(symbol.Position)
				result.push(new vscode.SymbolInformation(symbol.Name, symbol.Kind, symbol.Container, new vscode.Location(uri, position)))
			}
		}

		return result
	}
}

let diagnostics: vscode.DiagnosticCollection

/**
 * Returns whether the specified character is a character
 */
function is_alphabet(character: string) {
	return (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z');
}

/**
 * Returns whether the specified character is a digit
 */
function is_digit(character: string) {
	return character >= '0' && character <= '9';
}

const DIAGNOSTICS_TIMER_PRECISION = 100
const MAXIMUM_DIAGNOSTICS_DELAY = 500

class DocumentPosition {
	Line: number
	Character: number

	constructor(line: number, character: number) {
		this.Line = line
		this.Character = character
	}
}

class DocumentRange {
	Start: DocumentPosition
	End: DocumentPosition

	constructor(start: DocumentPosition, end: DocumentPosition) {
		this.Start = start
		this.End = end
	}
}

class DocumentDiagnostic {
	Range: DocumentRange
	Message: string
	Severity: number

	constructor(range: DocumentRange, message: string, severity: number) {
		this.Range = range
		this.Message = message
		this.Severity = severity
	}
}

class FileDivider {
	File: string
	Data: string

	constructor(file: string, data: string) {
		this.File = file
		this.Data = data
	}
}

class DocumentAnalysisResponse {
	Status: number
	Path: string
	Data: string

	constructor(status: number, path: string, data: string) {
		this.Status = status
		this.Path = path
		this.Data = data
	}
}

function to_internal_position(position: DocumentPosition) {
	return new vscode.Position(position.Line, position.Character)
}

function to_internal_range(range: DocumentRange) {
	return new vscode.Range(to_internal_position(range.Start), to_internal_position(range.End))
}

function to_internal_diagnostic(diagnostic: DocumentDiagnostic) {
	return new vscode.Diagnostic(to_internal_range(diagnostic.Range), diagnostic.Message, diagnostic.Severity)
}

function create_diagnostics_handler(diagnostics_service: CompilerService) {
	var previous = new Date()
	var document: vscode.TextDocument
	var diagnose = false
	var is_diagnosed = true

	// Creat the timer which decides whether to send the request to get the diagnostics
	setInterval(async () => {
		const now = new Date()

		// If diagnostics are required or 500 milliseconds has elapsed and previous diagnostics have arrived, ask for diagnostics
		if (!diagnose && now.getTime() - previous.getTime() < MAXIMUM_DIAGNOSTICS_DELAY) return

		// 1. Wait until the previous diagnostics arrive
		// 2. Document content must be valid
		if (!is_diagnosed || document === undefined) return

		diagnose = false
		previous = now
		is_diagnosed = false

		try {
			const bytes = await diagnostics_service.send(RequestType.Diagnose, document, new vscode.Position(0, 0))
			const response = to_response(bytes)

			const uri = vscode.Uri.file(response.Path)
			const items = JSON.parse(response.Data) as DocumentDiagnostic[]

			if (uri === undefined || items === undefined) return

			diagnostics.set(uri, items.map(i => to_internal_diagnostic(i)))
		}
		catch {}

		is_diagnosed = true

	}, DIAGNOSTICS_TIMER_PRECISION)

	// Create the diagnostics signaler
	vscode.workspace.onDidChangeTextDocument(event => {
		// If any of the changes insert an operator character or a line ending, the document should be diagnosed
		for (let change of event.contentChanges) {
			for (let i = 0; i < change.text.length; i++) {
				let c = change.text.charAt(i)

				if (is_alphabet(c) || is_digit(c) || c == ' ') {
					continue
				}

				document = event.document
				diagnose = true
			}
		}
	})
}

/**
 * Starts all operations using the output of the compiler service
 */
async function start_compiler_service(context: vscode.ExtensionContext, output: string) {
	console.log('Vivid compiler service is active!')

	const detail_provider_port = 1111 // parseInt(output)

	const detail_provider = new BufferedSocket((error) => {
		if (error.message.includes('ECONNREFUSED')) {
			vscode.window.showErrorMessage('Vivid: Failed to connect to the compiler service')
		}

		console.error(`Compiler service connection error: ${error}`)
	})

	const diagnostics_provider = new BufferedSocket((error) => {
		if (error.message.includes('ECONNREFUSED')) {
			vscode.window.showErrorMessage('Vivid: Failed to connect to the compiler service')
		}

		console.error(`Compiler service connection error: ${error}`)
	})

	console.log('Connecting to the compiler service...')

	await detail_provider.connect(1111)
	await diagnostics_provider.connect(2222)

	console.log('Registering the completion item provider...')

	// Create a compiler service and add a completion item provider which uses it
	const detail_service = new CompilerService(detail_provider, 1111)
	const diagnostics_service = new CompilerService(diagnostics_provider, 2222)

	// Open the current workspace
	const folder = vscode.workspace.workspaceFolders?.map(i => i.uri.path)[0] ?? '';
	Promise.all([ detail_service.open(folder), diagnostics_service.open(folder) ]).catch(() => {
		vscode.window.showErrorMessage('Compiler services could not open the current workspace', { modal: true })
	});

	context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
		{ language: 'vivid' },
		new CompletionItemProvider(detail_service),
		'.',
		'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
		'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'
	))

	context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(
		{ language: 'vivid' },
		new SignatureHelpProvider(detail_service),
		'(', ','
	))

	context.subscriptions.push(vscode.languages.registerDefinitionProvider(
		{ language: 'vivid' },
		new DefinitionProvider(detail_service)
	))

	context.subscriptions.push(vscode.languages.registerHoverProvider(
		{ language: 'vivid' },
		new HoverProvider(detail_service)
	))

	context.subscriptions.push(vscode.languages.registerReferenceProvider(
		{ language: 'vivid' },
		new ReferenceProvider(detail_service)
	))

	context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(
		new WorkspaceSymbolProvider(detail_service)
	))

	diagnostics = vscode.languages.createDiagnosticCollection('vivid')
	context.subscriptions.push(diagnostics)

	create_diagnostics_handler(diagnostics_service)
}

/**
 * Executes the compiler service executable and attempts to connect to it.
 * On success, a completion item provider is registered.
 * On failure, an information box is shown to user, which directs the user to install the required components.
 */
function execute_compiler_service(context: vscode.ExtensionContext) {
	// Start the compiler service
	const service = require('child_process').spawn('Vivid.exe', [ '-s' ])

	if (service.pid == undefined) {
		console.log('Could not start Vivid compiler service')

		vscode.window.showErrorMessage('Could not start Vivid compiler service. Is the Vivid compiler installed on your system and is it visible to this extension?', { modal: true })
		return
	}

	// The following function should only start if the compiler service has successfully activated
	service.stdout.on('data', (data: Buffer) => {
		const output = data.toString('utf-8')
		start_compiler_service(context, output)
	})
}

/**
 * This function activates the whole extension
 */
export function activate(context: vscode.ExtensionContext) {
	console.log('Vivid language extension starting...')

	//execute_compiler_service(context)
	start_compiler_service(context, "1111")

	const disposable = vscode.commands.registerCommand('extension.hello', () => {
		vscode.window.showInformationMessage('Hello')
	})

	context.subscriptions.push(disposable)
}