# Working on Ramble

Read [CONTRIBUTING.md](CONTRIBUTING.md) first; its ground rules bind agents too.

## Real data never enters the repository

This is a public repository for a service that sees people's WhatsApp. Production
logs (an opted-in account's 🔬 trace carries transcripts, contact names and ids),
`DATA_DIR`, `/admin/research/...` and the owner's own chats are for *diagnosing*
only. Nothing read there may be copied into source, comments, tests, docs, commit
messages or PR text: no contact or chat names, numbers, jids/lids, message or
transcript text, account ids, hostnames.

When a production failure becomes a regression test, rebuild it from invented
data with the same *shape* (same tiers, scripts, emoji, word order), and
describe the failure in general terms ("a name that is only the last word of a
contact outranked an exact match"), not with what was actually said or to whom.
Never name a fixture `real`.

## Commits

- Author is Tomer Cohen <tomer.van.cohen@gmail.com>; never a work identity.
- `git config core.hooksPath .githooks` is expected to be set: the hooks refuse
  staged lines, messages and author identities that match the local
  `.private-terms` file. If a hook stops you, fix the content; don't bypass it.
