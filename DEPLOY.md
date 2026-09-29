# Deploying trace

trace runs as one Docker Compose stack on one Linux server. The target this
guide uses is Oracle Cloud's Always Free tier: an ARM server with 4 cores and
24 GB of memory that costs nothing and does not sleep. Any Ubuntu server with
8 GB or more works the same way.

Why one server rather than free platform tiers: the ml service needs about
3 GB of memory with its models loaded, and the api, worker and ml service pass
uploaded files through a shared volume. Render's and Vercel's free tiers have
neither the memory nor a disk.

## 1. Create the server (once, about 15 minutes)

1. Sign up at <https://signup.cloud.oracle.com>. A card is asked for to verify
   identity; Always Free resources are not charged. Pick a home region close
   to your users (for India, Mumbai or Hyderabad). It cannot be changed later.
2. **Compute → Instances → Create instance.**
   - **Image:** Canonical Ubuntu 24.04.
   - **Shape:** Ampere, `VM.Standard.A1.Flex`, 4 OCPUs, 24 GB memory.
   - **Networking:** create a new VCN with a public subnet, and keep
     "Assign a public IPv4 address" on.
   - **SSH keys:** "Paste public keys", and paste the contents of
     `~/.ssh/trace_deploy.pub` from this machine.
   - **Boot volume:** 100 GB (the free tier allows up to 200 GB).
   
   If it says the shape is out of capacity, try another availability domain,
   or fewer OCPUs, and again later. Free ARM capacity comes and goes.
3. **Open the web ports.** On the instance page, open the subnet, then its
   **Security list → Add ingress rules**: source `0.0.0.0/0`, TCP, destination
   port `80`; then the same for `443`.
4. Note the instance's **public IP address**.

## 2. Deploy (one command)

From the repository root on this machine:

```bash
SIGNUP_ALLOWLIST="you@example.com,@yourcollege.edu" deploy/deploy.sh ubuntu@<public-ip>
```

The first run installs Docker, opens the host firewall, writes the server's
`.env` with new secrets (your API keys are copied from your local `.env`),
builds the images and starts the stack. The build takes 15-25 minutes. When
it finishes it prints the address, for example
`https://152-67-10-20.sslip.io`.

`SIGNUP_ALLOWLIST` decides who can create an account: exact emails and whole
`@domain`s, comma-separated. Leave it empty to let anyone register. On a
public URL that means strangers' questions spend your free Groq and Gemini
quota, so set it unless that is what you want.

## 3. Updating

Commit or not, the working tree is what is deployed:

```bash
deploy/deploy.sh ubuntu@<public-ip>
```

Only the code is synced. The server's `.env`, database, uploads and index are
never overwritten. To change a setting on the server, edit `~/trace/.env`
there and run the deploy again.

## Using your own domain

Point an `A` record at the server's IP, then deploy once with the domain as
the second argument:

```bash
deploy/deploy.sh ubuntu@<public-ip> trace.example.com
```

For an existing server, also set `TRACE_DOMAIN=trace.example.com` in the
server's `~/trace/.env`. Caddy obtains and renews the certificate itself.

## Operating it

```bash
ssh -i ~/.ssh/trace_deploy ubuntu@<public-ip>
cd ~/trace
alias dc='docker compose -f docker-compose.yml -f docker-compose.prod.yml'
dc ps                     # what is running
dc logs -f api worker     # follow the api and ingestion
dc restart api            # restart one service
```

**Backups** run every night at 03:15 server time into `~/backups/<date>/`:
the database dump, the uploaded files, and a snapshot of the vector index.
Seven days are kept. Copy them off the server now and then; a backup on the
same disk does not survive losing the disk.

**What is exposed:** only Caddy, on ports 80 and 443. Postgres, Redis,
Qdrant, the ml service and the api are reachable only inside the Compose
network. HTTP redirects to HTTPS, and the session cookie is `Secure`.

**Free-tier limits** that will show up in use: Groq's free keys allow a fixed
number of tokens per minute and per day for each model. When the grading
model runs out, grading falls back to the answer model; when both run out,
answers say the service limit was reached rather than blaming the documents.
A paid Groq key, or a second provider in `LLM_FALLBACK_PROVIDER`, removes the
limit.
