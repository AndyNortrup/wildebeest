import type { MastodonStatus } from 'wildebeest/backend/src/types/status'
import type { Actor } from 'wildebeest/backend/src/activitypub/actors/'
import { toMastodonStatusFromRow } from './status'
import { PUBLIC_GROUP } from 'wildebeest/backend/src/activitypub/activities'
import type { Cache } from 'wildebeest/backend/src/cache'

export async function pregenerateTimelines(domain: string, db: D1Database, cache: Cache, actor: Actor) {
	const timeline = await getHomeTimeline(domain, db, actor)
	await cache.put(actor.id + '/timeline/home', timeline)
}

export async function getHomeTimeline(domain: string, db: D1Database, actor: Actor): Promise<Array<MastodonStatus>> {
	const { results: following } = await db
		.prepare(
			`
            SELECT
                actor_following.target_actor_id as id,
                json_extract(actors.properties, '$.followers') as actorFollowersURL
            FROM actor_following
            INNER JOIN actors ON actors.id = actor_following.target_actor_id
            WHERE actor_id=? AND state='accepted'
        `
		)
		.bind(actor.id.toString())
		.all<{ id: string; actorFollowersURL: string | null }>()

	let followingIds: string[] = []
	let followingFollowersURLs: string[] = []

	if (following) {
		followingIds = following.map((row) => row.id)
		followingFollowersURLs = following.map((row) => {
			if (row.actorFollowersURL) {
				return row.actorFollowersURL
			} else {
				// We don't have the Actor's followers URL stored, we'll guess
				// one.
				return row.id + '/followers'
			}
		})
	}

	// follow ourself to see our statuses in the our home timeline
	followingIds.push(actor.id.toString())

	const QUERY = `
SELECT objects.*,
       actors.id as actor_id,
       actors.cdate as actor_cdate,
       actors.properties as actor_properties,
       outbox_objects.actor_id as publisher_actor_id,
       (SELECT count(*) FROM actor_favourites WHERE actor_favourites.object_id=objects.id) as favourites_count,
       (SELECT count(*) FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id) as reblogs_count,
       (SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count,
       (SELECT count(*) > 0 FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id AND actor_reblogs.actor_id=?1) as reblogged,
       (SELECT count(*) > 0 FROM actor_favourites WHERE actor_favourites.object_id=objects.id AND actor_favourites.actor_id=?1) as favourited
FROM outbox_objects
INNER JOIN objects ON objects.id = outbox_objects.object_id
INNER JOIN actors ON actors.id = outbox_objects.actor_id
WHERE
     objects.type = 'Note'
     AND outbox_objects.actor_id IN (SELECT value FROM json_each(?2))
     AND json_extract(objects.properties, '$.inReplyTo') IS NULL
     AND (outbox_objects.target = '${PUBLIC_GROUP}' OR outbox_objects.target IN (SELECT value FROM json_each(?3)))
ORDER by outbox_objects.published_date DESC
LIMIT ?4
`
	const DEFAULT_LIMIT = 20

	const { success, error, results } = await db
		.prepare(QUERY)
		.bind(actor.id.toString(), JSON.stringify(followingIds), JSON.stringify(followingFollowersURLs), DEFAULT_LIMIT)
		.all()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	if (!results) {
		return []
	}

	const out: Array<MastodonStatus> = []

	for (let i = 0, len = results.length; i < len; i++) {
		const status = await toMastodonStatusFromRow(domain, db, results[i])
		if (status !== null) {
			out.push(status)
		}
	}

	return out
}

export enum LocalPreference {
	NotSet,
	OnlyLocal,
	OnlyRemote,
}

function localPreferenceQuery(preference: LocalPreference): string {
	switch (preference) {
		case LocalPreference.NotSet:
			return '1'
		case LocalPreference.OnlyLocal:
			return 'objects.local = 1'
		case LocalPreference.OnlyRemote:
			return 'objects.local = 0'
	}
}

export async function getPublicTimeline(
	domain: string,
	db: D1Database,
	localPreference: LocalPreference,
	offset: number = 0
): Promise<Array<MastodonStatus>> {
	const QUERY = `
SELECT objects.*,
       actors.id as actor_id,
       actors.cdate as actor_cdate,
       actors.properties as actor_properties,
       outbox_objects.actor_id as publisher_actor_id,
       (SELECT count(*) FROM actor_favourites WHERE actor_favourites.object_id=objects.id) as favourites_count,
       (SELECT count(*) FROM actor_reblogs WHERE actor_reblogs.object_id=objects.id) as reblogs_count,
       (SELECT count(*) FROM actor_replies WHERE actor_replies.in_reply_to_object_id=objects.id) as replies_count
FROM outbox_objects
INNER JOIN objects ON objects.id=outbox_objects.object_id
INNER JOIN actors ON actors.id=outbox_objects.actor_id
WHERE objects.type='Note'
      AND ${localPreferenceQuery(localPreference)}
      AND json_extract(objects.properties, '$.inReplyTo') IS NULL
      AND outbox_objects.target = '${PUBLIC_GROUP}'
ORDER by outbox_objects.published_date DESC
LIMIT ?1 OFFSET ?2
`
	const DEFAULT_LIMIT = 20

	const { success, error, results } = await db.prepare(QUERY).bind(DEFAULT_LIMIT, offset).all()
	if (!success) {
		throw new Error('SQL error: ' + error)
	}
	if (!results) {
		return []
	}

	const out: Array<MastodonStatus> = []

	for (let i = 0, len = results.length; i < len; i++) {
		const status = await toMastodonStatusFromRow(domain, db, results[i])
		if (status !== null) {
			out.push(status)
		}
	}

	return out
}
