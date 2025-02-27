import type { MessageBody, DeliverMessageBody } from 'wildebeest/backend/src/types/queue'
import { getSigningKey } from 'wildebeest/backend/src/mastodon/account'
import * as actors from 'wildebeest/backend/src/activitypub/actors'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors'
import type { Env } from './'
import { generateDigestHeader } from 'wildebeest/backend/src/utils/http-signing-cavage'
import { signRequest } from 'wildebeest/backend/src/utils/http-signing'
import { deliverToActor } from 'wildebeest/backend/src/activitypub/deliver'

const headers = {
	'content-type': 'application/activity+json',
}

export async function handleDeliverMessage(env: Env, actor: Actor, message: DeliverMessageBody) {
	const toActorId = new URL(message.toActorId)
	const targetActor = await actors.getAndCache(toActorId, env.DATABASE)
	if (targetActor === null) {
		console.warn(`actor ${toActorId} not found`)
		return
	}

	const signingKey = await getSigningKey(message.userKEK, env.DATABASE, actor)
	await deliverToActor(signingKey, actor, targetActor, message.activity)
}
