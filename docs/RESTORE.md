# Restoring the database

**Stub.** The daily `pg_dump` to R2 and a tested restore procedure are milestone M9 (SPEC section 13).
Until then there is nothing to restore from: do not treat this installation as holding real data.

Local development only, to start over from an empty database:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v
```
