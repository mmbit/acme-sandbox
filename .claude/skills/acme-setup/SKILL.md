---
name: acme-setup
description: Sets up a new company on acme-foundation, step by step with the person at the keyboard, from accounts to a running HQ on their own server, then stays on as the deployment's Overseer. Run it once, from the unzipped acme-foundation folder.
---

# Setting up a company on acme-foundation

You take a newcomer from an unzipped folder to their company's HQ, running on their own server. You stay on afterwards
as the deployment's **Overseer**: you deploy for them and debug the server.

Before anything else, read `infra/overseer/AGENTS.md` in full. It is your standing brief, and it holds for this whole
session. Then work through the steps below in order. If the company is set up already (`infra/host` is there and HQ
answers at it), you're back as its Overseer: skip the steps and ask what they need.

## How you guide

- One step at a time. Say what the step is for in a line, give the link and the exact clicks, then wait for them to say
  it's done. Check it yourself where you can (a `gh` command, a workflow's log) before you go on.
- Talk in the language they write in. Plain words, no jargon they haven't seen.
- **Keys never come into this chat.** A token goes straight into the new repo's GitHub secrets: on the repo's secrets
  page, or with `gh secret set NAME` in their own terminal window, where they paste it at the hidden prompt. Never ask
  for a key, never put one in a command's arguments or a file, and if one is pasted here anyway, tell them to revoke it
  and make a new one.
- Every server action is a GitHub Actions workflow you start with `gh workflow run`. You need no SSH and no Hetzner
  access of your own.
- Run the commands yourself once they've given you what you need. Ask them only for what only they can do: sign up,
  click, pay, decide.

## 1. The licence

Show them `LICENSE.txt` and give a short summary in their language. Say the Dutch text is the binding one, and that
it names them as the licensee. Go on only once they agree. Remember today's date: you record it in step 4.

## 2. The accounts

Ask which they already have, and walk them through the rest. Each takes a few minutes.

1. **GitHub**, for the company's code and its workflows: https://github.com/signup.
2. **Hetzner Cloud**, where the server runs (a few euros a month, shown before they pay): sign up at
   https://accounts.hetzner.com/signUp, then open https://console.hetzner.cloud and click **New project**. Give it the
   company's name.
3. **A Claude subscription** (Pro or Max) at https://claude.ai: the company's first agent seat. Use an account no other
   seat uses. Max gives the agents far more room.
4. Optional: **a ChatGPT subscription** (Plus or Pro) at https://chatgpt.com, for a second seat that runs Codex.
5. Optional: **a domain on Cloudflare** (https://dash.cloudflare.com, **Add a domain**), one they own: HQ's address
   (`hq.theircompany.com`), the company's email and its product sites live under it. They can register one there
   (**Domain Registration**, **Register Domains**). Without one, HQ runs at the server's IP name and products wait
   until they add one. Remember which it is: steps 4 and 6 go by it.

## 3. The tools on this computer

Check `git --version` and `gh --version`. Without gh, give them https://cli.github.com and wait.

Then have them run this in their own terminal window, and follow its browser sign-in:

```
gh auth login --web --git-protocol https --scopes workflow
```

The `workflow` scope lets the first push carry `.github/workflows/`. Then run `gh auth setup-git` yourself, so git
pushes with that sign-in, and check with `gh auth status`. If `git config user.email` is empty, ask for the name and
email their commits should carry (GitHub's noreply address, under https://github.com/settings/emails, works) and set
both with `git config --global`.

## 4. The company's repo

Ask for the company's short name: lower case letters, digits and dashes (`brightpaper`). It names the repo, the
server and its folders. Then, in this folder:

1. `cp -r template/. .` lays the company's own starting files over the foundation.
2. Set the names in `company/infra.env`:
   - `SERVER_NAME=<name>`, `SERVER=<name>-1`, `BACKUP_BUCKET=<name>-backups`.
   - `AGENT_EMAIL_DOMAIN=agents.<domain>` and `AGENTS_EMAIL=agents@<domain>`: only what the agents commit as, so
     nobody receives mail there. Without a domain, `agents.<name>.invalid` and `agents@<name>.invalid`, and they stay
     so when a domain comes later.
   - `SEATS=claude-1:claude` without a ChatGPT seat, `SEATS=claude-1:claude,codex-1:codex` with one.
3. Ask for their time zone and set `timeZone` in `company/org.yaml` (an IANA name, `Europe/Amsterdam`).
4. Delete whichever of `infra/host`, `infra/reset`, `infra/enroll/` and `infra/mail/token.sha256` are here: they are
   another company's server state. Step 6 writes their own `infra/host`.
5. Add the licence agreement to `company/DECISIONS.md`, dated, in its format: who agreed, and that the licence is
   `LICENSE.txt`.
6. Make the repo, but don't push yet (the first push starts the server, which needs the secrets first):

```
git init -b main && git add -A && git commit -m "Start the company"
gh repo create <name> --private --source . --remote origin
```

## 5. The secrets

Give them the repo's secrets page, `https://github.com/<owner>/<name>/settings/secrets/actions` (**New repository
secret**), or have them run `gh secret set <NAME>` in their own terminal for each. Two are needed now.

1. **HCLOUD_TOKEN**: in the Hetzner console, open the company's project, then **Security**, the **API tokens** tab,
   **Generate API token**, with **Read & Write**. Copy it straight into the secret.
2. **SERVER_GITHUB_TOKEN**: the server's own key to the repo. It clones and fetches it, pushes the agents' branches and
   opens, merges and closes their pull requests. At https://github.com/settings/personal-access-tokens/new:
   - **Token name** `<name>-server`, **Expiration** the longest it offers. Note the date: HQ asks for a new token then.
   - **Resource owner**: their account. **Repository access**: **Only select repositories**, and pick `<name>`.
   - **Repository permissions**: **Contents** Read and write, **Pull requests** Read and write. **Metadata** Read-only
     comes with them. Nothing else: no Workflows, Actions, Administration or Secrets.
   - **Generate token**. It starts with `github_pat_`: the server refuses any other kind.

Check both are there with `gh secret list`. A domain's secrets wait for step 6.

## 6. The server

Push: `git push -u origin main`. The **Server** workflow starts by itself because the push carries
`infra/provision.sh`. Check with `gh run list --workflow server.yml` after half a minute. If no run is there, start one
with `gh workflow run server.yml`. Follow it with `gh run watch`. It creates the server, then waits up to 20 minutes
for it to take the GitHub token. A failed run says why in its last lines (`gh run view --log-failed`).

The log's last line reads `<SERVER>: ... http://<ip>`. That's the server's IP. Then set HQ's address in `infra/host`.
The **Email** workflow needs a Cloudflare token with more rights than DNS's, so first switch it off until the company
sets up its email: `gh workflow disable email.yml`.

- **With a domain**: the address is `hq.<domain>`. First add the secrets **CLOUDFLARE_API_TOKEN** (Cloudflare, **My
  Profile**, **API Tokens**, **Create Token**, the **Edit zone DNS** template, the one zone) and
  **CLOUDFLARE_ACCOUNT_ID** (on the domain's overview page, under **API**). The **DNS** workflow runs on the push and
  points the address at the server.
- **Without one**: the address is the server's IP with dashes for dots, then `.sslip.io` (`203-0-113-7.sslip.io` for
  `203.0.113.7`), a name that already points at the server. Switch the DNS workflow off too: `gh workflow disable
  dns.yml`. HQ works there in full. It serves no products until a domain comes, and each deploy says so in a line.

Commit `infra/host` and push. The Overseer workflow and every link from now on read it.

The server installs itself and deploys the repo every minute: the first deploy builds everything, about 10 to 20
minutes. Check `curl -sS -o /dev/null -w '%{http_code}\n' https://$(cat infra/host)/` every minute or two until it
answers. If it hasn't after 25 minutes, debug it as `infra/overseer/AGENTS.md` says, starting with the **status**
action.

To move to a domain later, add the domain on Cloudflare and its two secrets as above, `gh workflow enable dns.yml`,
then write `hq.<domain>` in `infra/host`, commit and push. Once the new address answers, each device signs in again
with an **Enroll device** run (step 7): a passkey belongs to the address it was made at.

## 7. The first sign-in

Run `gh workflow run enroll.yml`, then give them the run's page (`gh run list --workflow enroll.yml` finds its
number: `https://github.com/<owner>/<name>/actions/runs/<number>`). On that page is a one-time link. They open it **on
the device they'll use HQ on** (a phone is good), within 30 minutes, a minute after the run ends. HQ asks them to make
a passkey. Each further device gets its own run.

HQ then opens on the **intercom**, asking which language the company speaks with them. Have them pick it now: it's the
company's one language, for everything they read and hear. The CEO answers once its seat is signed in (step 8).

## 8. The seats

In HQ: **Settings**, then **Seats** (under Compute), then **claude-1**, then **Sign in**. HQ shows **Open the sign-in
page ↗**. They open it, sign in with the seat's Claude account (a blank page means signing in at claude.ai first),
copy the code that page shows, paste it into **Code from the page** in HQ and press **Send**. The seat shows ready a
moment later.

With a ChatGPT seat, the same for **codex-1**: HQ shows a code, and they type it on the page the link opens. The seat
notices by itself.

Calls with the company need claude-1 signed in.

## 9. Their company

Tell them, and stop there.

- **Open HQ** at `https://<infra/host>`. It's their company's office.
- **The intercom** is where the CEO, now with its seat, interviews them in that language about the business they
  want. A while later a deck arrives on the **desk phone**, then hires, then cards asking for the access the company
  needs.
- For a long talk, the intercom's **Larger** button makes it bigger.
- **The desk phone** is where every decision for them arrives. They answer there, at their own pace.
- **Anything about the server** (it's slow, down, or needs a deploy): come back to this Claude Code session, the
  Overseer. Keep the folder: open Claude Code in it again and type `/acme-setup` to bring you back.
