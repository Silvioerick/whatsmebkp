/* eslint-disable camelcase */
import { proto } from '../../WAProto'


type buttonParamsJson = {
	display_text: string
	id: string
	url?: string
	merchant_url?: string
	copy_code?: string
	disabled: boolean
}


const createButton = (button: any) => {
	switch (button?.type) {
	case 'url':
		return {
			name: 'cta_url',
			buttonParamsJson: JSON.stringify({
				display_text: button?.buttonText?.displayText || '',
				id: button.id,
				url: button.url,
				disabled: false
			})
		}

	default:
		return {
			name: 'quick_reply',
			buttonParamsJson: JSON.stringify({
				display_text: button?.buttonText?.displayText || '',
				id: button.buttonId,
				disabled: false
			})
		}
	}
}

const createInteractiveButtonsFromButton = (buttons: any) => {
	const buttonsArray: any[] = []
	buttons?.map((button: any) => {
		buttonsArray.push(createButton(button))
	})
	return buttonsArray
}

const getType = (message: any) => {
	if(message.image || message.imageMessage) {
		return 'image'
	} else if(message.video || message.videoMessage) {
		return 'video'
	} else if(message.document || message.documentMessage) {
		return 'document'
	}

	return 'text'
}

const createHeader = (message: proto.Message.IButtonsMessage | null | undefined): proto.Message.InteractiveMessage.IHeader => {
	if(!message) {
		return {
			title: '',
			hasMediaAttachment: false
		}
	}


	let hasMedia = false
	const MediaType = getType(message) + 'Message'
	if(message.documentMessage || message.imageMessage || message.videoMessage) {
		hasMedia = true
	}

	const header = {
		title: hasMedia ? message[MediaType]?.caption : '',
		hasMediaAttachment: hasMedia,
		[MediaType]: message[MediaType]
	}
	return header

}

const convertInteractiveHeaderToTemplateMedia = (message: proto.Message.InteractiveMessage.IHeader): proto.Message.IImageMessage | proto.Message.VideoMessage | proto.Message.DocumentMessage | null => {
	if(message.hasMediaAttachment) {
		if(message.documentMessage) {
			return {
				fileName: message.documentMessage.fileName || '',
				mimetype: message.documentMessage.mimetype || '',
				url: message.documentMessage.url

			}
		} else if(message.imageMessage) {
			return {
				caption: message.imageMessage.caption || '',
				url: message.imageMessage.url
			}
		} else if(message.videoMessage) {
			return {
				caption: message.videoMessage.caption || '',
				mimetype: message.videoMessage.mimetype || '',
				url: message.videoMessage.url
			}
		}
	}

	return null
}

const convertButtonsToInteractive = (msg: proto.Message.IButtonsMessage) => {
	msg = JSON.parse(JSON.stringify(msg))
	const header = createHeader(msg)
	return {
		documentWithCaptionMessage: {
			message: {
				interactiveMessage: {
					footer: {
						text: msg?.footerText
					},
					body: {
						text: msg?.contentText
					},
					header,
					nativeFlowMessage: {
						buttons: createInteractiveButtonsFromButton(msg?.buttons ?? [])
					}
				}
			}
		}
	}
}

const createButtonsFromInteractive = (buttons: any): proto.Message.ButtonsMessage.IButton[] => {
	const buttonsArray: proto.Message.ButtonsMessage.IButton[] = []
	buttons?.map((button: any) => {
		return buttonsArray.push({
			buttonId: button?.buttonParamsJson?.id || '',
			buttonText: {
				displayText: button?.buttonParamsJson?.display_text || ''
			},
			type: 1,
		})
	})
	return buttonsArray
}

const createTemplateButtonsFromInteractive = (buttons: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton[]): proto.IHydratedTemplateButton[] => {
	const buttonsArray: proto.IHydratedTemplateButton[] = []
	buttons?.map((button: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton, index: number) => {
		if(button.name === 'quick_reply') {
			const quickReplyButton: buttonParamsJson = JSON.parse(button.buttonParamsJson!)
			const quick_reply_button: proto.HydratedTemplateButton.IHydratedQuickReplyButton = {
				displayText: quickReplyButton.display_text,
				id: quickReplyButton.id,
			}
			buttonsArray.push({ quickReplyButton: quick_reply_button, index:index + 1 })
		} else if(button.name === 'cta_url') {
			const ctaUrlButton: buttonParamsJson = JSON.parse(button.buttonParamsJson!)
			const cta_url_button: proto.HydratedTemplateButton.IHydratedURLButton = {
				displayText: ctaUrlButton.display_text,
				url: ctaUrlButton.url,
				//@ts-ignore


			}
			buttonsArray.push({ urlButton: cta_url_button, index:index + 1 })
		} else if(button.name === 'cta_copy') {
			const ctaCopyButton: buttonParamsJson = JSON.parse(button.buttonParamsJson!)
			const cta_copy_button: proto.HydratedTemplateButton.IHydratedURLButton = {
				displayText: ctaCopyButton.display_text,
				url: `https://www.whatsapp.com/otp/code/?otp_type=COPY_CODE&code=${ctaCopyButton.copy_code}`
			}
			buttonsArray.push({ urlButton: cta_copy_button, index:index + 1 })
		}
	})
	return buttonsArray
}

const convertInteractiveToTemplate = (msg: proto.Message.IInteractiveMessage): proto.Message.TemplateMessage.IHydratedFourRowTemplate => {
	const media = convertInteractiveHeaderToTemplateMedia(msg.header!)
	return {
		hydratedContentText: msg.body?.text || '',
		hydratedFooterText: msg.footer?.text || '',
		hydratedButtons: createTemplateButtonsFromInteractive(msg.nativeFlowMessage?.buttons ?? []),
		imageMessage: media?.mimetype?.startsWith('image') ? media as proto.Message.IImageMessage : undefined,
		videoMessage: media?.mimetype?.startsWith('video') ? media as proto.Message.IVideoMessage : undefined,
		documentMessage: media?.mimetype?.startsWith('application') ? media as proto.Message.IDocumentMessage : undefined


	}
}


const patchWebButtonsMessage = (msg: proto.IMessage): proto.IMessage => {
	if(msg.documentWithCaptionMessage?.message?.interactiveMessage) {
		msg = {
			templateMessage: {
				fourRowTemplate: {},
				hydratedTemplate: convertInteractiveToTemplate(msg.documentWithCaptionMessage.message.interactiveMessage)
			}
		}
	}

	return msg
}

export const patchButtonsMessage = (msg: proto.IMessage, currentJid?: string | null): proto.IMessage => {
	const isMobile = !currentJid?.includes(':') || false

	if(!isMobile) {
		return patchWebButtonsMessage(msg)
	}

	// need to patch sender Device

	return msg
}