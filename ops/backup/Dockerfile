# The backup container (SPEC section 13): every few hours it dumps the database and copies the
# product pictures, encrypted, to a repository that is NOT on this server (Cloudflare R2, Backblaze
# B2 or any S3). restic does the encryption, de-duplication and retention. See docs/DEPLOY.md.
FROM alpine:3.20

RUN apk add --no-cache restic postgresql16-client curl tzdata \
 && mkdir -p /ops /var/lib/backup

COPY entrypoint.sh backup.sh prune.sh drill.sh restore-media.sh /ops/
# (a checkout on Windows may have given the scripts Windows line endings, which Linux cannot run)
RUN sed -i 's/\r$//' /ops/*.sh && chmod +x /ops/*.sh

# Unhealthy when no backup has succeeded for 8 hours: `docker compose ps` shows it at a glance.
HEALTHCHECK --interval=15m --timeout=10s --start-period=30m \
  CMD find /var/lib/backup/last-ok -mmin -480 | grep -q . || exit 1

ENTRYPOINT ["/ops/entrypoint.sh"]
