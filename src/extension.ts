import { createSocket, RemoteInfo, Socket, SocketType } from 'dgram';
import * as vscode from 'vscode'
import { SignatureHelp } from 'vscode';
import { SignatureInformation } from 'vscode';

enum RequestType {
	Completions = 1,
	Signatures = 2,
	Diagnose = 3,
	Open = 4,
	Definition = 5,
	Information = 6
}

class CompilerService {
	private socket: Socket
	private port: number

	/**
	 * Creates a compiler service using the specified active socket and a port
	 */
	constructor(socket: Socket, port: number) {
		this.socket = socket
		this.port = port
	}

	/**
	 * Bundles the specified document with the specified position and sends it using the socket
	 * @param document Contents of the current document as a string
	 * @param position The current position inside the specified document
	 */
	public send(request: RequestType, document: vscode.TextDocument, position: vscode.Position) {
		const payload = JSON.stringify({ Type: request as number, Uri: document.uri.toString(), Document: document.getText(), Position: { Line: position.line, Character: position.character } })
		this.socket.send(payload, this.port, "localhost")
	}

	/**
	 * Sends a command to the service to open the specified folder
	 */
	public open(folder: string) {
		const payload = JSON.stringify({ Type: RequestType.Open as number, Uri: folder, Document: '', Position: { Line: -1, Character: -1 } })
		this.socket.send(payload, this.port, "localhost")
		return this.response()
	}

	/**
	 * Creates a promise of a reponse in string format
	 */
	public response() {
		return new Promise<string>((resolve) => {
			this.socket.once('message', (data: Buffer, _: RemoteInfo) => {
				resolve(data.toString('utf-8'))
			})
		})
	}
}

class CompletionItemProvider implements vscode.CompletionItemProvider {
	private service: CompilerService

	/**
	 * Creates a completion item provider which attempts to give the user autocompletions, using the specified compiler service
	 */
	constructor(service: CompilerService) {
		this.service = service
	}

	public provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, _: vscode.CancellationToken) : Promise<vscode.CompletionItem[]> {
		// Send the current state of the document to the compiler service, which will analyze it
		this.service.send(RequestType.Completions, document, position)

		return this.service.response()
			.then(response => JSON.parse(response) as { Status: number, Uri: vscode.Uri, Data: string })
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
			.then(response => JSON.parse(response) as { Status: number, Uri: vscode.Uri, Data: string })
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
				const signature = new SignatureInformation(i.Identifier, i.Documentation)
				signature.parameters = i.Parameters.map(i => new vscode.ParameterInformation(i.Name, i.Documentation))
				
				return signature
			}))
			.then(signatures => {
				const result = new SignatureHelp()
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
			.then(response => JSON.parse(response) as { Status: number, Uri: vscode.Uri, Data: string })
			.then(response => {
				// If the response code is zero, it means the request has succeeded, and that there should be the location of the definition included
				if (response.Status == 0) {
					const location = JSON.parse(response.Data) as { Start: { Line: number, Character: number }, End: { Line: number, Character: number } }
					const start = new vscode.Position(location.Start.Line, location.Start.Character)
					const end = new vscode.Position(location.End.Line, location.End.Character)

					var text = response.Uri.toString()
					
					return new vscode.Location(vscode.Uri.parse(text), new vscode.Range(start, end))
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
			.then(response => JSON.parse(response) as { Status: number, Uri: vscode.Uri, Data: string })
			.then(response => {
				// If the response code is zero, it means the request has succeeded, and that there should be information about the currently selected symbol included
				if (response.Status == 0) {
					const markdown = new vscode.MarkdownString()
					markdown.appendCodeblock(response.Data, 'vivid')

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

/**
 * Converts the specified 32-bit number into a byte array
 * @returns Byte array which represents the specified 32-bit number
 */
 function to_bytes(number: number) {
	return new Uint8Array([
		(number & 0xff000000) >> 24,
		(number & 0x00ff0000) >> 16,
		(number & 0x0000ff00) >> 8,
		(number & 0x000000ff)
	])
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
function start_compiler_service(context: vscode.ExtensionContext, output: string) {
	console.log('Vivid compiler service is active!')
		
	const specified_request_port = parseInt(output)
	const specific_request_socket = createSocket('udp4')
	const diagnostics_socket = createSocket('udp4')

	console.log('Registering the completion item provider...')
	
	// Create a compiler service and add a completion item provider which uses it
	const specific_request_service = new CompilerService(specific_request_socket, 1111)
	const diagnostics_service = new CompilerService(diagnostics_socket, 2222)
	
	// Open the current workspace
	const folder = vscode.workspace.workspaceFolders?.map(i => i.uri.path)[0] ?? '';
	Promise.all([ specific_request_service.open(folder), diagnostics_service.open(folder) ]).catch(() => {
		vscode.window.showErrorMessage('Compiler services could not open the current workspace', { modal: true })
	});

	context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
		{ language: 'vivid' },
		new CompletionItemProvider(specific_request_service),
		'.', 
		'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
		'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'
	))

	context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(
		{ language: 'vivid' },
		new SignatureHelpProvider(specific_request_service),
		'(', ','
	))

	context.subscriptions.push(vscode.languages.registerDefinitionProvider(
		{ language: 'vivid' },
		new DefinitionProvider(specific_request_service)
	))

	context.subscriptions.push(vscode.languages.registerHoverProvider(
		{ language: 'vivid' },
		new HoverProvider(specific_request_service)
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
	console.log('Vivid languange extension starting...')

	//execute_compiler_service(context)
	start_compiler_service(context, "1111")

	const disposable = vscode.commands.registerCommand('extension.hello', () => {
		vscode.window.showInformationMessage('Hello')
	})

	context.subscriptions.push(disposable)
}