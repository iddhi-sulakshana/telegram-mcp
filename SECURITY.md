# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**, or go straight to
<https://github.com/iddhi-sulakshana/telegram-mcp/security/advisories/new>. Only the maintainers
can see the report.

A useful report says which version or commit you looked at, what an attacker has to be able to do
first (for example "write in a chat Claude is watching"), what they gain, and how to reproduce it.
Please give us a chance to fix the problem before you share the details publicly.

## What this project protects

`telegram-mcp` runs a local daemon on your own Telegram account. It listens on `127.0.0.1` only, and
everything except `/health` needs a token kept in your OS keystore. The rules file decides which
chats Claude may send to without asking, which need your approval, and which are blocked. The
following are in scope:

- a way for a Claude session, or a message from someone in a chat, to send, edit or delete
  something the rules say needs your approval, or to change the rules itself;
- a way to read or send local files that the file checks are meant to refuse;
- a leak of the daemon token, the Telegram login session or the API credentials;
- another local user or a web page reaching the daemon without the token.

## Supported versions

Fixes go into the latest release and `main`.
