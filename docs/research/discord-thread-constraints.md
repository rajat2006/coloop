# Discord thread and bot constraints for a Collaboration Episode

Research date: 2026-08-23

## Question

Which Discord bot and API capabilities and constraints govern a dedicated server
thread where an Owner, collaborators, and an Episode Agent converse and the
Owner finalizes or cancels the Collaboration Episode?

## Direct answer

The v0 experience is feasible with a **guild-installed Discord bot using the
Gateway for inbound events and the HTTP API for thread and message writes**.
That is the minimal Discord transport combination that supports both natural,
free-form conversation in a thread and native finalize/cancel controls. Gateway
interactions and ordinary message events can share the same persistent
WebSocket connection; interaction responses and all thread/message mutations
still go through HTTP. Discord describes Gateway as its primary event transport
and says most resource events, including messages, are not available as HTTP
webhook events. ([Gateway](https://docs.discord.com/developers/events/gateway),
[events overview](https://docs.discord.com/developers/events/overview),
[interaction callback](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback))

For the validation release, this process can run on the Owner's local machine.
The Gateway is an outbound WebSocket connection from the bot to Discord, and
bot REST calls are outbound HTTP, so this design does not require a public URL
or a VPS. This is an inference from Discord's documented connection direction.
The local process must remain awake and connected; a VPS or other always-on
process becomes necessary when episodes must continue while the Owner's machine
is offline. ([Gateway connection lifecycle](https://docs.discord.com/developers/events/gateway#connection-lifecycle),
[bot authentication](https://docs.discord.com/developers/platform/oauth2-and-permissions#bot-token))

A private thread is the closest Discord primitive to a bounded Collaboration
Episode because only invited members and moderators can view it. A public
thread is visible to everyone who can view its parent channel. This is not a
complete authorization boundary by itself: every participant also needs
`VIEW_CHANNEL` on the parent, and the application must separately enforce that
only the recorded Owner's Discord user ID may finalize or cancel. ([public and
private threads](https://docs.discord.com/developers/topics/threads#public-private-threads),
[thread permissions](https://docs.discord.com/developers/topics/threads#permissions),
[inherited permissions](https://docs.discord.com/developers/topics/permissions#inherited-permissions-threads))

## Transport comparison

| Mechanism | Receives ordinary thread messages? | Receives commands/buttons? | Can write to a thread? | Hosting shape | Fit for v0 |
| --- | --- | --- | --- | --- | --- |
| Gateway plus bot HTTP API | Yes, through `MESSAGE_CREATE` with the appropriate intents | Yes, through `INTERACTION_CREATE` | Yes, through bot-authenticated HTTP routes | Persistent outbound WebSocket; no public inbound endpoint | **Required for natural conversation** |
| HTTP interactions endpoint | No; it receives only commands, components, and modal submissions | Yes | An interaction response can write in the invocation context; later bot HTTP calls can also write | Public, signature-validating HTTP endpoint | Useful alternative for command-only apps, not the Episode conversation |
| Incoming channel webhook | No; it is write-only | No incoming interaction handling | Yes, with `thread_id`; posting automatically unarchives the thread | Outbound HTTP only | Optional output mechanism, but redundant beside the bot |
| Application webhook events | No guild/thread message event exists in the supported event list | No; interactions use their own endpoint | No; these are notifications to the app | Public, signature-validating HTTP endpoint | Not useful for Episode conversation |

Gateway provides `GUILD_MESSAGES` events for message create/update/delete, while
the privileged `MESSAGE_CONTENT` intent controls whether content, embeds,
attachments, components, and polls are populated. Without that intent, message
content is empty except for messages the app sent, DMs with the app, messages
mentioning the app, and the target of a message context command. For a whole
thread conversation in which collaborators need not mention the Episode Agent
on every turn, v0 therefore needs `GUILDS`, `GUILD_MESSAGES`, and
`MESSAGE_CONTENT`; the privileged intent must be enabled in the Developer
Portal and requires approval once the app qualifies for verification.
([Gateway intents](https://docs.discord.com/developers/events/gateway#list-of-intents),
[message content intent](https://docs.discord.com/developers/events/gateway#message-content-intent))

An app receives interactions either over the Gateway or at an HTTP interactions
endpoint, and Discord makes those two delivery modes mutually exclusive. In
either mode the application must acknowledge an interaction within three
seconds; the per-interaction token then remains valid for follow-up responses
for 15 minutes. Deferring the response is the correct pattern when generating
an Episode Outcome or other agent work will exceed the initial deadline.
([receiving interactions](https://docs.discord.com/developers/interactions/receiving-and-responding#receiving-an-interaction),
[callback deadline and token lifetime](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback))

HTTP interactions would require a public endpoint, Ed25519 signature validation
on every request, and the initial `PING` handshake. It removes the persistent
connection only for command/component-driven experiences; it does not deliver
ordinary collaborator messages. ([preparing for interactions](https://docs.discord.com/developers/interactions/overview#preparing-for-interactions),
[HTTP interactions](https://docs.discord.com/developers/platform/interactions#http-interactions))

Incoming webhooks are deliberately one-way. They can post to an existing thread
using `thread_id`, but cannot listen or respond to users; application webhook
events cover a small, enumerated set such as authorization and entitlement
changes, not guild message creation. Webhook events are also documented as not
real-time and not guaranteed to arrive in order. ([webhooks overview](https://docs.discord.com/developers/platform/webhooks),
[execute webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook),
[webhook event types](https://docs.discord.com/developers/events/webhook-events#event-types))

## Thread lifecycle, membership, and permissions

Discord exposes public, private, and announcement threads. A public thread in a
text channel starts from an existing message; a private thread can be created
without a source message in a text channel. The create-without-message endpoint
currently defaults to private but Discord says a future API version will make
the type required, so the implementation should always send an explicit
`PRIVATE_THREAD` type. ([thread types](https://docs.discord.com/developers/topics/threads#public-private-threads),
[start thread without message](https://docs.discord.com/developers/resources/channel#start-thread-without-message))

Private thread visibility is membership-based: a participant must be invited or
have `MANAGE_THREADS`. Membership does not override the parent channel—every
participant still needs `VIEW_CHANNEL` there—and sending inside the thread needs
`SEND_MESSAGES_IN_THREADS`, not the parent's `SEND_MESSAGES`. Threads otherwise
inherit the parent's permissions. ([thread permissions](https://docs.discord.com/developers/topics/threads#permissions),
[permission bits](https://docs.discord.com/developers/topics/permissions#permissions-bitwise-permission-flags),
[inherited permissions](https://docs.discord.com/developers/topics/permissions#inherited-permissions-threads))

The bot's least-privilege installation should begin with `VIEW_CHANNEL`,
`SEND_MESSAGES`, `CREATE_PRIVATE_THREADS`, `SEND_MESSAGES_IN_THREADS`,
`READ_MESSAGE_HISTORY`, `ATTACH_FILES`, and `EMBED_LINKS` in the designated
parent channel. Collaborators need `VIEW_CHANNEL` and
`SEND_MESSAGES_IN_THREADS`; application commands also depend on
`USE_APPLICATION_COMMANDS`. `MANAGE_THREADS` is optional: it is needed if the
bot must view every private thread, lock/delete arbitrary threads, or enforce
an archive-and-lock terminal state. Discord's permission list defines these
capabilities, and channel overwrites can reduce permissions after installation.
([permission definitions](https://docs.discord.com/developers/topics/permissions#permissions-bitwise-permission-flags),
[OAuth2 permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions#permissions))

The API can join the current bot user, add another thread member, leave, and
remove a member. Joining or adding requires an active thread; adding another
member requires the ability to send in the thread. Removing another member
requires `MANAGE_THREADS`, except that the creator of a private thread may also
remove members. This makes a bot-created private thread useful for v0 without
granting server-wide moderation power, provided the product is satisfied with
creator-scoped member removal. ([thread member endpoints](https://docs.discord.com/developers/resources/channel#join-thread))

`GUILD_MEMBERS` is not required merely to identify the author of each received
message or interaction. It is required to enumerate thread members with the
member-list endpoint and to receive membership updates for other users; by
default `THREAD_MEMBERS_UPDATE` only reports changes involving the current bot
user. The app can therefore avoid this additional privileged intent if v0
tracks invited Discord user IDs itself and reconciles membership only through
its own add/remove actions. ([thread membership syncing](https://docs.discord.com/developers/topics/threads#syncing-for-other-users),
[Gateway intent caveats](https://docs.discord.com/developers/events/gateway#caveats))

Discord caps active threads and members per thread but does not publish fixed
numbers on the thread resource page. Creation, invite, and unarchive operations
must handle capacity and permission failures rather than assuming unlimited
space. A loss of channel access is especially subtle: the user or app remains
reported as a thread member, receives no new Gateway events, and gets no
thread-specific "access lost" event, so the bridge must check current
permissions and treat membership as insufficient proof of access. ([thread
resource behavior](https://docs.discord.com/developers/resources/channel#example-thread-channel),
[losing channel access](https://docs.discord.com/developers/topics/threads#losing-access-to-channels))

## Identity and Owner authority

Automation must use a Discord application bot user, not the Owner's normal
Discord token. A bot token authenticates a dedicated account separate from a
person, and bot users appear in servers with an `APP` tag. Discord expressly
forbids automating ordinary accounts as self-bots. ([bot identity](https://docs.discord.com/developers/platform/oauth2-and-permissions#bot-token),
[bots in servers](https://docs.discord.com/developers/platform/bots),
[self-bot policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots))

The Episode Agent should speak through that stable application identity.
Incoming webhooks may override their display username and avatar per message,
but Discord identifies a webhook-authored message through its `webhook_id`, and
the Developer Policy prohibits deceptive application identity. Using webhook
display overrides to impersonate the Owner, collaborator, or another agent
would therefore weaken provenance and is unnecessary for v0. ([webhook message
identity](https://docs.discord.com/developers/resources/message#message-object),
[webhook overrides](https://docs.discord.com/developers/resources/webhook#execute-webhook),
[Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy))

Discord's thread `owner_id` means the user who created the thread; it does **not**
mean the Coloop Owner. The application must keep its own immutable mapping from
episode ID to the authorized Owner's Discord snowflake. Component interaction
payloads include the invoking guild `member` (and its user) plus guild/channel
context, so finalize/cancel handlers can verify episode, thread, state, and
actor before committing an Episode Outcome. This authorization must be
idempotent because duplicate clicks, retries, and races are application-level
concerns. ([thread fields](https://docs.discord.com/developers/topics/threads#thread-fields),
[interaction object](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-object))

Discord identifies the actor, but it cannot know that the Discord user is the
same person who owns the Origin Session. A separate pairing or authorization
decision is therefore required before the bot can safely accept the first
finalize/cancel action.

## Messages, components, mentions, and files

Ordinary messages support up to 2,000 content characters, up to ten rich embeds
with a combined 6,000 characters, components, replies, and multipart file
attachments. A create-message request is capped at 25 MiB, while the default
per-file upload limit is 10 MiB and can be higher according to the user or
server; interactions expose the effective `attachment_size_limit`. Long Context
Packages and Episode Outcomes therefore need chunking or attached artifacts,
not a single message body. ([create message](https://docs.discord.com/developers/resources/message#create-message),
[uploading files](https://docs.discord.com/developers/reference#uploading-files),
[interaction object](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-object))

Finalize and Cancel can be buttons on an application-owned message. A click
produces a message-component interaction containing the component's `custom_id`
and the invoking member; the handler may defer, update the control message, or
send a response. After the first valid terminal transition, it should edit the
message to disable controls and render the durable state. ([message components](https://docs.discord.com/developers/components/using-message-components#using-message-components-with-interactions),
[component interaction data](https://docs.discord.com/developers/interactions/receiving-and-responding#message-component-data-structure),
[interaction response types](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback-type))

Generated content must always set `allowed_mentions` explicitly—normally with
an empty `parse` list and only deliberately selected user IDs—because regular
bot messages parse all mention types by default. Discord recommends sanitizing
user-provided strings and using `allowed_mentions` to prevent unintended pings.
([allowed mentions](https://docs.discord.com/developers/resources/message#allowed-mentions-object),
[create-message guidance](https://docs.discord.com/developers/resources/message#create-message))

Attachment CDN URLs are signed and contain an expiry timestamp. If an uploaded
prototype or accepted artifact must be part of the Episode Outcome after the
Discord URL expires, the bridge must copy the bytes into the episode's approved
artifact store while the URL is valid rather than preserving only the URL.
([attachment CDN URLs](https://docs.discord.com/developers/reference#signed-attachment-cdn-urls))

Discord's Developer Policy limits API data use to the application's stated
functionality, prohibits scraping, and prohibits using message content obtained
through the APIs to train an AI model without Discord's express permission.
The Episode Agent should process only messages and files in the selected
Collaboration Episode, avoid unrelated server history, and must not reuse the
content for model training. ([Developer Policy, data handling](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy#handle-data-with-care))

## Archival, timeouts, and terminal state

Discord threads have `active` and `archived` states. `auto_archive_duration` can
be 60, 1,440, 4,320, or 10,080 minutes, but Discord now defines it primarily as
how long the thread remains visible in the channel list after inactivity—not as
an application completion signal. Archived threads are generally immutable;
sending a message automatically unarchives one unless a moderator locked it.
([thread metadata](https://docs.discord.com/developers/resources/channel#thread-metadata-object),
[active and archived threads](https://docs.discord.com/developers/topics/threads#active-archived-threads))

Consequently, auto-archive must not finalize, cancel, or time out a Collaboration
Episode. The canonical terminal state belongs in Coloop's episode record and is
entered only through a valid Owner action (or a separately specified product
timeout). Archival can be a presentation/cleanup action after that transition.
If finalization must make the Discord thread immutable, the bot needs
`MANAGE_THREADS` to lock it; only users with that permission can later unarchive
a locked thread. ([locked threads](https://docs.discord.com/developers/topics/threads#locked-threads),
[modify thread](https://docs.discord.com/developers/resources/channel#modify-channel))

The three-second acknowledgement and 15-minute interaction-token lifetime are
per button click or command invocation, not an Episode duration. A fresh click
creates a fresh interaction. Application-level episode expiry, late messages,
and stale finalize controls therefore remain explicit lifecycle decisions.
([interaction callback](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback))

## Rate limits and delivery behavior

Discord's HTTP limits are dynamic, per-route and global, and often bucketed by
top-level channel, guild, or webhook resource. Discord instructs applications
not to hard-code limits; they must consume `X-RateLimit-*` headers and, on a 429,
wait for `Retry-After`/`retry_after`. Thread creation, member changes, messages,
and terminal-state edits therefore need a rate-limit-aware queue with
idempotency keys rather than immediate blind retries. ([HTTP rate limits](https://docs.discord.com/developers/topics/rate-limits))

For the Gateway, an app may send 120 events per connection per 60 seconds.
Initial `IDENTIFY` calls have concurrency limits and a global ceiling of 1,000
per 24 hours; `RESUME` does not count toward that ceiling. Normal episode writes
should use REST rather than Gateway sends, while the connection manager must
heartbeat, resume where possible, and avoid reconnect loops that repeatedly
identify. ([Gateway rate limiting](https://docs.discord.com/developers/events/gateway#rate-limiting),
[identifying](https://docs.discord.com/developers/events/gateway#identifying))

Gateway disconnects are expected. A successful Resume replays missed events in
order from the last sequence number, but a session can become invalid before
the app reconnects. Resume is therefore useful for transient network loss, not
a guarantee that a laptop which slept for hours receives every event. A robust
bridge must persist its last processed Discord message IDs and reconcile the
thread through message-history HTTP endpoints after a non-resumable restart.
The first sentence is documented behavior; the persistence/reconciliation rule
is the resulting design implication. ([resuming](https://docs.discord.com/developers/events/gateway#resuming),
[get channel messages](https://docs.discord.com/developers/resources/message#get-channel-messages))

## Hosting implications

### Local validation release

- Run one bot process beside the Codex bridge, holding the Gateway WebSocket and
  making bot-authenticated REST calls. No public port is required. This follows
  from Gateway's client-initiated connection lifecycle. ([Gateway connections](https://docs.discord.com/developers/events/gateway#connections))
- The process must remain awake. If it shuts down, collaborators can still post
  in Discord, but the Episode Agent cannot answer and terminal interactions
  cannot be acknowledged until a bridge is available; Discord invalidates an
  unacknowledged interaction after three seconds. ([interaction deadline](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-callback))
- Persist episode state locally before acknowledging terminal actions and use
  message-history reconciliation on restart. Resume alone has a bounded session
  lifetime and can fail. ([disconnect and resume](https://docs.discord.com/developers/events/gateway#disconnecting))

### Always-on production path

- A VPS, container service, or worker platform that supports long-lived
  WebSockets can host the same Gateway bot. An HTTP-only/serverless interactions
  handler is insufficient while free-form messages are part of the promise.
  ([Gateway connections](https://docs.discord.com/developers/events/gateway#connections),
  [HTTP interactions](https://docs.discord.com/developers/platform/interactions#http-interactions))
- A hybrid is possible later: an always-on relay owns Discord connectivity and
  durable episode state while an Owner-local adapter owns access to the Origin
  Session. That topology is an architectural decision, not a Discord
  requirement.
- Switching interactions from Gateway to an HTTP endpoint does not eliminate
  Gateway while ordinary messages remain. It would add a public signed endpoint
  and a second delivery path without removing the message connection, so it has
  no v0 advantage. ([mutually exclusive interaction transports](https://docs.discord.com/developers/interactions/receiving-and-responding#receiving-an-interaction),
  [Gateway interactions](https://docs.discord.com/developers/platform/interactions#gateway-interactions))

## Implications for downstream map decisions

The research settles these feasibility points:

1. A local-machine validation release is viable; a VPS is not technically
   required until offline continuity is required.
2. A guild-installed bot, Gateway, and bot HTTP API are the v0 Discord seam.
   Incoming webhooks and application event webhooks cannot carry the
   conversation.
3. Natural conversation requires the `MESSAGE_CONTENT` privileged intent. A
   command/mention-only fallback would be a materially different product.
4. A private thread is the likely bounded surface, but access still depends on
   parent-channel permissions and explicit thread membership.
5. Owner finalization is an application authorization decision keyed by Discord
   user ID. Discord thread ownership and auto-archive are not valid substitutes.
6. The local bridge needs durable event cursors and restart reconciliation;
   Gateway Resume alone is insufficient for long offline periods.
7. Accepted Discord files need timely ingestion into an approved artifact store
   if the Episode Outcome must retain them after their signed URLs expire.

The following fog is now precise enough to become decision tickets:

- **Bind the Origin Owner to Discord authority:** How does a Collaboration
  Episode prove and persist that a particular Discord user ID belongs to the
  Owner of the Origin Session before accepting Finalize or Cancel?
- **Choose the Discord terminal presentation:** After a valid terminal action,
  does v0 only disable controls and mark the thread finalized/cancelled, or also
  archive and lock it—thereby requiring `MANAGE_THREADS` and a recovery path?
- **Specify non-resumable restart reconciliation:** When the local Gateway bridge
  restarts after its Discord session can no longer resume, which messages are
  replayed from history, how are duplicates suppressed, and what collaborator
  feedback is shown while the Episode Agent was unavailable?
- **Define accepted-artifact custody:** When are Discord attachment bytes copied
  out of expiring CDN URLs, where are they stored, and what retention/deletion
  rule applies to accepted versus rejected artifacts?
