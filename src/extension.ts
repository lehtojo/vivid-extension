import { TextDecoder } from 'util'
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

const BUFFERED_SOCKET_CAPACITY = 10000000
const BUFFERED_SOCKET_SLEEP_INTERVAL = 10

class BufferedSocket {
	private socket: net.Socket
	private buffer: Uint8Array
	private position: number = 0

	constructor(on_error: (error: Error) => void) {
		this.socket = new net.Socket({ writable: true, readable: true })
		this.buffer = new Uint8Array(BUFFERED_SOCKET_CAPACITY)

		// Copy the received fragments to the allocated buffer
		this.socket.on('data', (data) => {
			data.copy(this.buffer, this.position)
			this.position += data.length
		})

		this.socket.on('error', on_error)
		this.socket.on('end', () => console.log('Compiler service connection is now closed'))
	}

	connect(port: number, host?: string) {
		return new Promise<void>((resolve, _) => {
			this.socket.connect(port, host || '127.0.0.1', () => resolve())
		})
	}

	async read(size: number) {
		// Wait for the specified amount of bytes to arrive
		while (this.position < size) {
			// Sleep for 10ms, so that other tasks are executed
			await new Promise((resolve, _) => setTimeout(resolve, BUFFERED_SOCKET_SLEEP_INTERVAL))
		}

		// Extract the requested part
		const result = this.buffer.slice(0, size)

		this.buffer.copyWithin(0, size) // Remove the received part
		this.position -= size // Update the position, since we removed the received part

		return result
	}

	write(data: string | Uint8Array) {
		this.socket.write(data)
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
	 * Converts the specified number into four byte array
	 */
	int32_to_bytes(value: number) {
		return new Uint8Array([ value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >> 24) & 0xFF ])
	}

	/**
	 * Expects the specified byte array to have four bytes and converts them into a 32-bit number (little endian).
	 */
	bytes_to_int32(bytes: Uint8Array) {
		return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
	}

	/**
	 * Bundles the specified document with the specified position and sends it using the socket
	 * @param document Contents of the current document as a string
	 * @param position The current position inside the specified document
	 */
	public send(request: RequestType, document: vscode.TextDocument, position: vscode.Position) {
		const payload = JSON.stringify({ Type: request as number, Uri: document.uri.toString(true), Document: document.getText(), Position: { Line: position.line, Character: position.character } })
		this.socket.write(this.int32_to_bytes(payload.length))
		this.socket.write(payload)
	}

	public query(request: RequestType, query: string) {
		const payload = JSON.stringify({ Type: request as number, Uri: '', Document: '', Position: { Line: -1, Character: -1 }, Query: query })
		this.socket.write(this.int32_to_bytes(payload.length))
		this.socket.write(payload)
	}

	/**
	 * Sends a command to the service to open the specified folder
	 */
	public open(folder: string) {
		const payload = JSON.stringify({ Type: RequestType.Open as number, Uri: folder, Document: '', Position: { Line: -1, Character: -1 } })
		this.socket.write(this.int32_to_bytes(payload.length))
		this.socket.write(payload)
		return this.response()
	}

	/**
	 * Creates a promise of a response in string format
	 */
	public response() {
		return new Promise<string>(async (resolve, reject) => {
			// Wait for the size of the message to arrive
			var buffer = await this.socket.read(4)

			// Determine the size of the payload
			const size = this.bytes_to_int32(buffer)
			if (size <= 0 || size > 10000000) reject(new Error('Message has too large payload'))

			// Wait for the message to arrive fully
			buffer = await this.socket.read(size)

			// Convert the received buffer into a string
			resolve(new TextDecoder('utf-8').decode(buffer))
		})
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

	public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, _: vscode.CancellationToken) : Promise<vscode.CompletionItem[]> {
		// Send the current state of the document to the compiler service, which will analyze it
		this.service.send(RequestType.Completions, document, position)

		return this.service.response()
			.then(response => JSON.parse(response) as DocumentAnalysisResponse)
			.then(response => {
				// If the response code is zero, it means the request has succeeded, and that there should be an array of completion items included
				if (response.Status == 0) {
					return JSON.parse(response.Data) as { Identifier: string, Type: number }[]
				}

				// Since the request has failed, check if there is an error message included to be shown to the user
				if (response.Data.length > 0) {
					vscode.window.showErrorMessage(response.Data)
				}

				// Return an empty array of completion items, since no items could be produced
				return []
			})
			.then(items => items.map(i => new vscode.CompletionItem(i.Identifier, i.Type)))
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

	public provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, _: vscode.CancellationToken) {
		// Send the current state of the document to the compiler service, which will analyze it
		this.service.send(RequestType.Signatures, document, position)

		return this.service.response()
			.then(response => JSON.parse(response) as DocumentAnalysisResponse)
			.then(response => {
				// If the response code is zero, it means the request has succeeded, and that there should be an array of completion items included
				if (response.Status == 0) {
					return JSON.parse(response.Data) as { Identifier: string, Documentation: string, Parameters: { Name: string, Documentation: string }[] }[]
				}

				// Since the request has failed, check if there is an error message included to be shown to the user
				if (response.Data.length > 0) {
					vscode.window.showErrorMessage(response.Data)
				}

				// Return an empty array of completion items, since no items could be produced
				return []
			})
			.then(items => items.map(i => {
				const signature = new vscode.SignatureInformation(i.Identifier, i.Documentation)
				signature.parameters = i.Parameters.map(i => new vscode.ParameterInformation(i.Name, i.Documentation))

				return signature
			}))
			.then(signatures => {
				const result = new vscode.SignatureHelp()
				result.signatures = signatures
				result.activeParameter = 0
				result.activeSignature = 0

				return result
			})
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

	public provideDefinition(document: vscode.TextDocument, position: vscode.Position, _: vscode.CancellationToken) {
		// Request the definition location of the current position from the compiler service
		this.service.send(RequestType.Definition, document, position)

		return this.service.response()
			.then(response => JSON.parse(response) as DocumentAnalysisResponse)
			.then(response => {
				// If the response code is zero, it means the request has succeeded, and that there should be the location of the definition included
				if (response.Status == 0) {
					const location = JSON.parse(response.Data) as DocumentRange
					const start = new vscode.Position(location.Start.Line, location.Start.Character)
					const end = new vscode.Position(location.End.Line, location.End.Character)

					return new vscode.Location(vscode.Uri.parse(response.Uri), new vscode.Range(start, end))
				}

				// Since the request has failed, check if there is an error message included to be shown to the user
				if (response.Data.length > 0) {
					vscode.window.showErrorMessage(response.Data)
				}

				return new vscode.Location(document.uri, position)
			})
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

	public provideHover(document: vscode.TextDocument, position: vscode.Position, _: vscode.CancellationToken) {
		// Request the information about the currently selected symbol
		this.service.send(RequestType.Information, document, position)

		return this.service.response()
			.then(response => JSON.parse(response) as DocumentAnalysisResponse)
			.then(response => {
				// If the response code is zero, it means the request has succeeded, and that there should be information about the currently selected symbol included
				if (response.Status == 0) {
					const markdown = new vscode.MarkdownString()
					markdown.appendCodeblock(JSON.parse(response.Data), 'vivid')

					return new vscode.Hover(markdown, undefined)
				}

				// Since the request has failed, check if there is an error message included to be shown to the user
				if (response.Data.length > 0) {
					vscode.window.showErrorMessage(response.Data)
				}

				return new vscode.Hover('', undefined)
			})
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

	public provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, _: vscode.CancellationToken) {
		this.service.send(RequestType.FindReferences, document, position)

		return this.service.response()
			.then(response => JSON.parse(response) as DocumentAnalysisResponse)
			.then(response => {
				// If the response code is zero, it means the request has succeeded, and that there should be reference locations included
				if (response.Status == 0) {
					return JSON.parse(response.Data) as FileDivider[]
				}

				// Since the request has failed, check if there is an error message included to be shown to the user
				if (response.Data.length > 0) {
					vscode.window.showErrorMessage(response.Data)
				}

				return []
			})
			.then(files => {
				const locations: vscode.Location[] = []

				for (const file of files) {
					const uri = vscode.Uri.parse(file.File)
					const positions = JSON.parse(file.Data) as DocumentPosition[]

					for (const position of positions) {
						locations.push(new vscode.Location(uri, new vscode.Position(position.Line, position.Character)));
					}
				}

				return locations
			})
	}
}

class WorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
	private service: CompilerService

	constructor(service: CompilerService) {
		this.service = service
	}

	async provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): Promise<vscode.SymbolInformation[]> {
		// Request symbol information with the specified query
		this.service.query(RequestType.WorkspaceSymbols, query)

		// Wait for the response of the query
		const response = JSON.parse(await this.service.response()) as DocumentAnalysisResponse

		// If the response code is zero, it means the request has succeeded, and that there should be reference locations included
		if (response.Status != 0) {
			// Since the request has failed, check if there is an error message included to be shown to the user
			if (response.Data.length > 0) vscode.window.showErrorMessage(response.Data)
			return []
		}

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
	Uri: string
	Data: string

	constructor(status: number, uri: string, data: string) {
		this.Status = status
		this.Uri = uri
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
	setInterval(() => {
		let now = new Date()

		// If diagnostics are required or 500 milliseconds has elapsed and previous diagnostics have arrived, ask for diagnostics
		if (!diagnose && now.getTime() - previous.getTime() < MAXIMUM_DIAGNOSTICS_DELAY) {
			return
		}

		if (!is_diagnosed || document == undefined) {
			return
		}

		diagnose = false
		previous = now
		is_diagnosed = false

		diagnostics_service.send(RequestType.Diagnose, document, new vscode.Position(0, 0))

		// Handle the response from the diagnostics service
		diagnostics_service.response()
			.then(response => JSON.parse(response) as { Status: number, Uri: string, Data: string })
			.then(response => {
				is_diagnosed = true

				// If the response code is zero, it means the request has succeeded, and that there should be an array of completion items included
				if (response.Status == 0) {
					let uri = vscode.Uri.parse(response.Uri)
					return { Uri: uri, Items: JSON.parse(response.Data) as DocumentDiagnostic[] }
				}

				// Since the request has failed, check if there is an error message included to be shown to the user
				if (response.Data.length > 0) {
					vscode.window.showErrorMessage(response.Data)
				}

				// Return an empty array of completion items, since no items could be produced
				return {}
			})
			.then(response => {
				if (response?.Uri == undefined || response.Items == undefined) {
					return
				}

				var items = response.Items.map(i => to_internal_diagnostic(i))
				diagnostics.set(response.Uri, items)
			})

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