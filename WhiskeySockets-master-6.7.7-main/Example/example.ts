import { Boom } from '@hapi/boom'
import NodeCache from 'node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, BinaryInfo, delay, DisconnectReason, downloadAndProcessHistorySyncNotification, encodeWAM, fetchLatestBaileysVersion, getAggregateVotesInPollMessage, getHistoryMsg, isJidNewsletter, makeCacheableSignalKeyStore, makeInMemoryStore, PHONENUMBER_MCC, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey, WAMessageStubType } from '../src'
//import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'
import P from 'pino'

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')
const useMobile = process.argv.includes('--mobile')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

const onDemandMap = new Map<string, string>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)


const filterMessages = (msg: any) => {
  if (msg.message?.protocolMessage) {
    if(msg.message.protocolMessage.type === 'MESSAGE_EDIT' || msg.message.protocolMessage.type === 'REVOKE') {
      return true
    }
    return false
  }
  if(msg?.messageStubType === 2 && msg?.messageStubParameters[0] === 'Message absent from node') return true
  if(msg?.messageStubParameters && msg?.messageStubParameters[0] === 'Key used already or never filled') return true
  if (
    [
      WAMessageStubType.E2E_DEVICE_CHANGED,
      WAMessageStubType.E2E_IDENTITY_CHANGED,
      WAMessageStubType.CIPHERTEXT,
      WAMessageStubType.CALL_MISSED_VOICE,
      WAMessageStubType.CALL_MISSED_VIDEO,
      WAMessageStubType.CALL_MISSED_GROUP_VOICE,
      WAMessageStubType.CALL_MISSED_GROUP_VIDEO
    ].includes(msg.messageStubType)
  ) { return false }

  return true
}


// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: !usePairingCode,
		mobile: useMobile,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage,
	})

	store?.bind(sock.ev)

	// Pairing code for Web clients
	if(usePairingCode && !sock.authState.creds.registered) {
		if(useMobile) {
			throw new Error('Cannot use pairing code with mobile api')
		}

		const phoneNumber = await question('Please enter your mobile phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	// If mobile was chosen, ask for the code
	if(useMobile && !sock.authState.creds.registered) {
		const { registration } = sock.authState.creds || { registration: {} }

		if(!registration.phoneNumber) {
			registration.phoneNumber = await question('Please enter your mobile phone number:\n')
		}

		const libPhonenumber = await import("libphonenumber-js")
		const phoneNumber = libPhonenumber.parsePhoneNumber(registration!.phoneNumber)
		if(!phoneNumber?.isValid()) {
			throw new Error('Invalid phone number: ' + registration!.phoneNumber)
		}

		registration.phoneNumber = phoneNumber.format('E.164')
		registration.phoneNumberCountryCode = phoneNumber.countryCallingCode
		registration.phoneNumberNationalNumber = phoneNumber.nationalNumber
		const mcc = PHONENUMBER_MCC[phoneNumber.countryCallingCode]
		if(!mcc) {
			throw new Error('Could not find MCC for phone number: ' + registration!.phoneNumber + '\nPlease specify the MCC manually.')
		}

		registration.phoneNumberMobileCountryCode = mcc

		async function enterCode() {
			try {
				const code = await question('Please enter the one time code:\n')
				const response = await sock.register(code.replace(/["']/g, '').trim().toLowerCase())
				console.log('Successfully registered your phone number.')
				console.log(response)
				rl.close()
			} catch(error) {
				console.error('Failed to register your phone number. Please try again.\n', error)
				await askForOTP()
			}
		}

		async function enterCaptcha() {
			const response = await sock.requestRegistrationCode({ ...registration, method: 'captcha' })
			const path = __dirname + '/captcha.png'
			fs.writeFileSync(path, Buffer.from(response.image_blob!, 'base64'))

			open(path)
			const code = await question('Please enter the captcha code:\n')
			fs.unlinkSync(path)
			registration.captcha = code.replace(/["']/g, '').trim().toLowerCase()
		}

		async function askForOTP() {
			if (!registration.method) {
				await delay(2000)
				let code = await question('How would you like to receive the one time code for registration? "sms" or "voice"\n')
				code = code.replace(/["']/g, '').trim().toLowerCase()
				if(code !== 'sms' && code !== 'voice') {
					return await askForOTP()
				}

				registration.method = code
			}

			try {
				await sock.requestRegistrationCode(registration)
				await enterCode()
			} catch(error) {
				console.error('Failed to request registration code. Please try again.\n', error)

				if(error?.reason === 'code_checkpoint') {
					await enterCaptcha()
				}

				await askForOTP()
			}
		}

		askForOTP()
	}

	const sendMessageWTyping = async(msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						console.log('Connection closed. You are logged out.')
					}
				}
				
				// WARNING: THIS WILL SEND A WAM EXAMPLE AND THIS IS A ****CAPTURED MESSAGE.****
				// DO NOT ACTUALLY ENABLE THIS UNLESS YOU MODIFIED THE FILE.JSON!!!!!
				// THE ANALYTICS IN THE FILE ARE OLD. DO NOT USE THEM.
				// YOUR APP SHOULD HAVE GLOBALS AND ANALYTICS ACCURATE TO TIME, DATE AND THE SESSION
				// THIS FILE.JSON APPROACH IS JUST AN APPROACH I USED, BE FREE TO DO THIS IN ANOTHER WAY.
				// THE FIRST EVENT CONTAINS THE CONSTANT GLOBALS, EXCEPT THE seqenceNumber(in the event) and commitTime
				// THIS INCLUDES STUFF LIKE ocVersion WHICH IS CRUCIAL FOR THE PREVENTION OF THE WARNING
				const sendWAMExample = false;
				if(connection === 'open' && sendWAMExample) {
					/// sending WAM EXAMPLE
					const {
						header: {
							wamVersion,
							eventSequenceNumber,
						},
						events,
					} = JSON.parse(await fs.promises.readFile("./boot_analytics_test.json", "utf-8"))

					const binaryInfo = new BinaryInfo({
						protocolVersion: wamVersion,
						sequence: eventSequenceNumber,
						events: events
					})

					const buffer = encodeWAM(binaryInfo);
					
					const result = await sock.sendWAMBuffer(buffer)
					console.log(result)
				}

				console.log('connection update', update)
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
			}

			if(events['labels.association']) {
				console.log(events['labels.association'])
			}


			if(events['labels.edit']) {
				console.log(events['labels.edit'])
			}

			if(events.call) {
				console.log('recv call event', events.call)
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					console.log('received on-demand history sync, messages=', messages)
				}
				console.log(`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`)
			}

			// received a new message
			if(events['messages.upsert']) {
				const upsert = events['messages.upsert']
				//console.log('recv messages ', JSON.stringify(upsert, undefined, 2))
				let messagesArray = upsert?.messages?.filter(filterMessages).map((mensagem) => mensagem);
				for (const message of messagesArray ){
					
					if(message.key.fromMe){
						console.log('msg minha')
						return
					} else {
						try{
						console.log('msg chegou', JSON.stringify(message))
						 
						//console.log('message', JSON.stringify(message))
							const buttons = [
								{buttonId: 'id1', type: 2, buttonText: {displayText: 'Botao 1'}, nativeFlowInfo: {name: 'quick_reply', paramsJson: JSON.stringify({display_text: 'Botao 1', id: 'id1', disabled: false})}},
								{buttonId: 'id2', buttonText: {displayText: 'Botao 2'}, type: 1},
								{buttonId: 'id3', buttonText: {displayText: 'Botao 3'}, type: 1}
							]
							
							const buttonMessage = {
									text: "msg de botao",
									footer: 'aaa',
									buttons: buttons,
									image: {
										url: 'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png',
									},
									title: ' titulo aqui',
									caption: 'caption aqui'
							}
	
							const templateButtons = [
								//{index: 1, urlButton: {displayText: '⭐ Star Baileys on GitHub!', url: 'https://github.com/adiwajshing/Baileys'}},
								//{index: 2, callButton: {displayText: 'Call me!', phoneNumber: '+1 (234) 5678-901'}},
								{quickReplyButton: {displayText: 'This is a reply, just like normal buttons!', id: 'id-like-buttons-message'}},
							]
							
							const templateMessage = {
									text: "Hi it's a template message",
									footer: 'Hello World',
									templateButtons: templateButtons
							}

							const interactiveMessage: proto.Message.IInteractiveMessage = {
								body: {
									text: "e ai blz"
								}, 
								header: {
									title: "olha que legal"
								}, 
								nativeFlowMessage: {
									buttons: [
										// {
										// 	name: "quick_reply", 
										// 	buttonParamsJson: "{\"display_text\":\"SIM\",\"id\":\"6deb1c2f-7863-45eb-8b11-17a8f8131288\",\"disabled\":false}"
										// },
										// {
										{
											name: "cta_url", 
											buttonParamsJson: "{\"display_text\":\"Ir para Site2\",\"id\":\"aaaaaa-7863-45eb-8b11-17a8f8132388\",\"url\":\"https://www.google.com.br\",\"disabled\":false}"
										},
										{
											name: "cta_copy",
											buttonParamsJson: "{\"display_text\":\"Copiar Código\",\"id\":\"6deb1c2f-7863-45eb-8b11-17a8f8131288\",\"copy_code\":\"123456\",\"disabled\":false}"
										}
									]
								}
							}
							const interactiveMessage3: proto.Message.IInteractiveMessage = {
								body: {
									text: "Copia o codigo"
								}, 
								header: {
									title: "olha que legal"
								}, 
								nativeFlowMessage: {
									buttons: [
										{
											name: "cta_copy",
											buttonParamsJson: "{\"display_text\":\"Copiar Código\",\"id\":\"6deb1c2f-7863-45eb-8b11-17a8f8131288\",\"copy_code\":\"123456\",\"disabled\":false}"
										}
									]
								}
							}
							const interactiveMessage2: proto.Message.IInteractiveMessage = {
								body: {
									text: "agora com resposta"
								}, 
								header: {
									title: "olha que legal"
								}, 
								nativeFlowMessage: {
									buttons: [
										{
											name: "quick_reply", 
											buttonParamsJson: "{\"display_text\":\"LEGAL\",\"id\":\"6deb1c2f-7863-45eb-8b11-17a8f8131288\",\"disabled\":false}"
										},
										{
											name: "quick_reply", 
											buttonParamsJson: "{\"display_text\":\"IRADO\",\"id\":\"6deb1c2f-7863-45eb-8b11-17a8f8131288\",\"disabled\":false}"
										},
										{
											name: "quick_reply", 
											buttonParamsJson: "{\"display_text\":\"COOL\",\"id\":\"6deb1c2f-7863-45eb-8b11-17a8f8131288\",\"disabled\":false}"
										}
									
									]
								}
							}
							const messageToSend = {
								interactiveMessage: interactiveMessage
							}
							const messageToSend2 = {
								interactiveMessage: interactiveMessage2
							}
							const messageToSend3 = {
								interactiveMessage: interactiveMessage3
							}

							const listMessage: any = {
								
										buttonText: 'oi',
										description: 'ok',
										footerText: 'footer',
										listType: 1,
										sections: [
												{
														title: "Comandos",
														rows: [
																{
																		title: "Teste",
																		description: "Testando",
																		rowId: "testeee"
																}
														]
												}
										]
							}
							await sock.relayMessage(message.key.remoteJid!,
								{
										viewOnceMessageV2: {
												message: {
														listMessage: {
																buttonText: 'oi',
																description: 'ok',
																footerText: 'footer',
																listType: 1,
																sections: [
																		{
																				title: "Comandos",
																				rows: [
																						{
																								title: "Teste",
																								description: "Testando",
																								rowId: "testeee"
																						}
																				]
																		}
																]
														}
												}
										}
								},
								{}
						) 
							await sock.sendMessage(message.key.remoteJid!, messageToSend2, {})
							//await sock.sendMessage(message.key.remoteJid!, messageToSend3, {})
						
						
						} catch {
							console.log('erro ao enviar mensagem')

						}
				}
				}
			
		}

			// messages updated like status delivered, message deleted etc.
			if(events['messages.update']) {
				console.log(
					JSON.stringify(events['messages.update'], undefined, 2)
				)

				for(const { key, update } of events['messages.update']) {
					if(update.pollUpdates) {
						const pollCreation = await getMessage(key)
						if(pollCreation) {
							console.log(
								'got poll update, aggregation: ',
								getAggregateVotesInPollMessage({
									message: pollCreation,
									pollUpdates: update.pollUpdates,
								})
							)
						}
					}
				}
			}

			if(events['message-receipt.update']) {
				console.log(events['message-receipt.update'])
			}

			if(events['messages.reaction']) {
				console.log(events['messages.reaction'])
			}

			if(events['presence.update']) {
				console.log(events['presence.update'])
			}

			if(events['chats.update']) {
				console.log(events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const contact of events['contacts.update']) {
					if(typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock!.profilePictureUrl(contact.id!).catch(() => null)
						console.log(
							`contact ${contact.id} has a new profile pic: ${newUrl}`,
						)
					}
				}
			}

			if(events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		if(store) {
			const msg = await store.loadMessage(key.remoteJid!, key.id!)
			return msg?.message || undefined
		}

		// only if store is present
		return proto.Message.fromObject({})
	}
}

startSock()