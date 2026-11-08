# Deploying to a server

One small server runs everything with Docker Compose (`docker-compose.prod.yml`): the database, the API,
Caddy (the web app, the pictures and HTTPS) and the backup service. This page is the whole procedure, in
the order to do it. It was run on a real server for the first time on 2026-11-08 (see "Lessons from the first deployment" at the end). Read it once through before starting.

## What you need first
| Thing | Notes |
| --- | --- |
| A server | Hetzner Cloud **CX22** (listed as **CX23** since late 2026) (2 vCPU, 4 GB RAM, 40 GB), Debian 12 or Ubuntu 24.04, in Germany (Falkenstein or Nuremberg). About 4–5 EUR a month; turn on the provider's own automatic server backups too (about 1 EUR) as a second layer. |
| A domain name | About 10 USD a year. HTTPS is required for the Home Screen app; a quick tunnel URL changes every time. |
| A place for the backups | **Not on this server, and at a different company**: a Cloudflare R2 or Backblaze B2 bucket (both have a free allowance). You need its endpoint, a bucket name and an access key pair. |
| A health-check address (optional but advised) | A free check at healthchecks.io: it emails you if no backup arrived for a while. Copy its ping URL. |

## 1. The server
Log in as root once, then:
```bash
adduser deploy && usermod -aG sudo deploy         # a normal user for everything after this
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown -R deploy:deploy /home/deploy/.ssh
```
Check you can log in as `deploy` **with your key from another terminal**, then lock the door:
```bash
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
sudo apt update && sudo apt install -y ufw unattended-upgrades git ca-certificates curl
sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw --force enable
sudo dpkg-reconfigure -plow unattended-upgrades    # security updates by themselves
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker deploy   # log out and in again
```
The database and the API are never published: only Caddy listens (80 and 443).

## 2. The domain
At your registrar (or at Cloudflare DNS) add an **A record** for the address the iPad will open, for example
`app.example.com`, pointing to the server's IP. In Cloudflare use "DNS only" (grey cloud), not "Proxied":
Caddy gets its own certificate. Wait until `ping app.example.com` shows the server's IP.

## 3. The code and the settings
```bash
git clone https://github.com/dia-312/HanashStore.git && cd HanashStore
cp .env.example .env && nano .env
```
Fill in `.env` (the comments in the file say what each is). The ones that matter:
- `POSTGRES_PASSWORD`: a long random one (`openssl rand -base64 24`).
- `DOMAIN` and `ACME_EMAIL`.
- `COOKIE_SECURE=true`.
- `RESTIC_REPOSITORY` (for R2: `s3:https://<account-id>.r2.cloudflarestorage.com/<bucket>`), `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`.
- `RESTIC_PASSWORD`: encrypts every backup. **Without it the backups cannot be read, even by you.** Put a copy in
  your password manager and one on paper in a safe place, *not* only on the server.
- `HC_URL`: the health-check ping address as an **https URL** (`https://hc-ping.com/<uuid>`). The `<uuid>@hc-ping.com` form is an email address: the backup scripts add `/start` and `/fail` to this value and call it with curl, so with the email form every ping fails silently and healthchecks.io reports a dead backup.
- `BACKUP_INIT=true`: **only for the very first start**, so the backup service may create the (empty) encrypted
  repository in the bucket. Remove the line afterwards. Without it, a wrong bucket name or wrong keys make the backup
  fail loudly instead of quietly making a repository in the wrong place.

## 4. Start
```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps          # postgres, api, caddy healthy; backup running
docker compose -f docker-compose.prod.yml logs backup  # the first backup runs at once: look for "backup finished"
```
The first start builds the web app inside Docker (a few minutes). Create the one user:
```bash
docker compose -f docker-compose.prod.yml exec -e ADMIN_PASSWORD='a long password' api python -m app.cli create-user --name "الاسم"
```
Open `https://app.example.com` on the iPad, log in, **add it to the Home Screen**, set the PIN.

## 5. Prove the backups before trusting anything (do not skip)
1. `docker compose -f docker-compose.prod.yml logs backup` shows "backup finished", and the health check shows green.
2. Run the restore drill: `bash scripts/restore-drill.sh`. It must end with **DRILL OK**. (How it works and what to do
   when it fails: `docs/RESTORE.md`.)
3. Only now import the real products (`Settings → Import products`), and re-run the drill after the first real day.

## Daily life
| What | How |
| --- | --- |
| Is it healthy? | `docker compose -f docker-compose.prod.yml ps` (all `healthy`/`running`), your health-check dashboard, and `https://app.example.com/api/health` |
| Logs | `docker compose -f docker-compose.prod.yml logs --tail 100 api` (they rotate by themselves: 3 files of 10 MB) |
| Backup schedule | every 4 hours at :15 (Hebron time); the old ones are forgotten at 03:45 (12 newest, 30 days, 12 months); the pictures keep a week of days, a month of weeks, half a year of months |
| Restore drill | monthly: `bash scripts/restore-drill.sh` |
| Export for yourself | in the app, Settings → "تصدير كل البيانات" |

## Updates
```bash
cd HanashStore && git pull
docker compose -f docker-compose.prod.yml up -d --build      # the database is migrated when the API starts
```
- Do this **in the evening**, when nobody is selling, and look at `ps` and `logs api` after.
- Rebuild at least **twice a year (before the end of March and the end of October)** even without code changes: the
  image carries the time-zone rules, and Palestine announces its daylight-saving dates each year.
- Image versions in `docker-compose.prod.yml` (`postgres:16.4`, Caddy 2.8) and `ops/*` are pinned on purpose. Raising
  one is a deliberate change: do it on a quiet day, then run the drill.
- The server's own operating system updates itself (unattended-upgrades); reboot it now and then
  (`sudo reboot`; everything restarts by itself).

## If something goes wrong
| Symptom | First look |
| --- | --- |
| The page does not open | `ps`: is `caddy` up? `logs caddy`: certificate problems almost always mean the DNS record is wrong or ports 80/443 are closed |
| Login says "too many attempts" | wait 15 minutes; it is the limit working |
| The iPad shows "error" in the header | the app's Sync screen says which command and why |
| The backup health check is red | `logs backup` shows the step that failed; the usual causes: wrong bucket keys, bucket full, disk full |
| The disk is nearly full | `docker system df`; `docker image prune` removes old images; logs are capped already |
| Something is wrong with the data | `docker compose -f docker-compose.prod.yml exec api python -m app.cli check-books` |
| The server is lost | `docs/RESTORE.md`, "The server is gone" |

## Not done yet (decisions for the owner)
- Nobody is watching the server day to day. The health check emails you when backups stop; add an uptime monitor
  on `/api/health` (UptimeRobot is free) so you hear when the whole site is down.
- No staging copy. Every update goes straight to the real one; the evening rule above is the safeguard.

## Lessons from the first deployment (2026-11-08)
- **Who owns what.** The client opens and pays for the accounts (server, domain, backup bucket, health check) with their own
  card; the developer works over SSH with his own key (only the public key goes into the provider's console). Keep the
  private key on one machine and give it a passphrase.
- **Server type.** The console lists one big default; scroll down and pick the smallest with 2 vCPU, 4 GB, 40 GB (CX23).
  Choose a German or Finnish location. Add the SSH key and tick Backups before "Create".
- **Domain.** Check the exact name that was bought before touching DNS (the first search showed a different spelling than the
  purchase). A fresh Porkbun domain carries a root `ALIAS` and a wildcard `CNAME` to its parking page; add an **A record** with
  host `app` pointing at the server, which wins over the wildcard. Do not start Caddy before
  `nslookup app.<domain> 1.1.1.1` shows the server's address (Let's Encrypt blocks repeated failures).
- **`.env` check without showing secrets:** print every variable with the length of secret values and flag leftovers of
  `<...>` templates. Passwords from `openssl rand -base64 24|32` are 32 and 44 characters, the R2 access key 32, its secret 64.
- **First backup** creates the encrypted repository only while `BACKUP_INIT=true`; after `backup finished` appears, delete that
  line and run `docker compose -f docker-compose.prod.yml up -d backup` again.
- **First user:** `read -rs ADMIN_PASSWORD; export ADMIN_PASSWORD`, then `exec -e ADMIN_PASSWORD api python -m app.cli
  create-user --name "..."`, then `unset ADMIN_PASSWORD`, so the password is not left in the shell history.
- **Product list:** the client's sheet had a selling price and a wholesale price column; only the selling price goes into the
  catalog (the app has one price per variant and no cost prices).
