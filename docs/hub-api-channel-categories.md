# Channel categories through the wallet-scoped Hub API

`GET /v1/groups/:groupId/channels` returns `channels`, `categories`, `ready`
and `snapshotVersion` from the native manager's existing
`getChannelMetadataBundle(groupId)`. Channels and categories use one SQLite WAL
snapshot and the active wallet's native read/admin visibility rules. An empty
category list is valid. The previous `channels` field remains compatible.

Categories have `categoryId`, `groupId`, `name` and `position`; channels reference
`categoryId` and have their own `position`. Display channels without a known
category in the default section. `cat-qchat-default` carries default-section
metadata rather than being an ordinary named category. Clients should group and
sort this metadata, and treat all names as untrusted text. Creating/reordering
categories continues through the native Hub administration interface; this
change exposes no new write or signing surface.

The headless daemon and Electron API share this boundary. Deploy through the
installation's normal Git/build lifecycle and rebuild the daemon for NuQloud
clients to receive categories; this is not a database migration. Verify a group
with multiple readable categories and a wallet without group access. For a
regression, forward-revert the API change and rebuild/restart through the same
operator-authorized lifecycle. Older clients ignore the additive fields; newer
clients retain a flat channel fallback against an older API.
