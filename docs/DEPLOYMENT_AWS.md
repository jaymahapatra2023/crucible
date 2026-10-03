# Deploying Crucible on AWS

One EC2 host running Docker Compose, RDS for the database, Caddy for TLS. This document says
why that shape and not another, then how to stand it up, deploy to it, and run it on the night.

Files:

| Path | What |
|---|---|
| `Dockerfile` | Two targets, `api` and `web`, built from source inside the image |
| `docker-compose.yml` | The production stack: `migrate` → `api` → `web` |
| `docker-compose.local.yml` | Overlay for a local trial: adds Postgres, plain HTTP on :8080 |
| `deploy/caddy/Caddyfile` | The edge: TLS, static app, `/api` and `/ws` proxied to the API |
| `deploy/aws/cdk/` | CDK app (TypeScript): VPC, host, database, secret, IAM, fixed IP, optional DNS. `cdk synth` emits the CloudFormation template |
| `deploy/aws/user-data.sh` | What the host installs on first boot |
| `deploy/aws/deploy.sh` | Check out a ref, pull the secret, build, migrate, restart |
| `deploy/aws/crucible.service` | systemd unit so the stack survives a reboot |
| `deploy/aws/secret.example.json` | The shape of the one secret the host reads |

---

## 1. The shape, and why

### One host, not a cluster

Crucible is **single-process by design**, and three parts of it depend on that:

- **The prober builds and runs submissions in containers**, with `--network none`, memory and PID
  limits, and a build context piped over stdin. It needs a Docker daemon it can talk to. ECS
  Fargate has no daemon to expose; ECS on EC2 would add a scheduler to manage one task that
  needs the host's socket anyway.
- **The rate ceilings live in process memory** (E41). Two replicas would silently halve every
  ceiling and count nobody's loop correctly. The file that declares them says so.
- **The scheduler and the pre-flight drain run in process** with an interval timer. The pre-flight
  queue *is* safe across instances (rows are claimed with `SKIP LOCKED`), but nothing else earns a
  second instance, and a 24-hour event for 200 people does not need one.

So: **one `m6i.xlarge`** (4 vCPU, 16 GB) with a 200 GB encrypted root volume for clones, scan
workspaces and the images builds leave behind, and a daily prune so those do not fill it.

The size is derived, not guessed. `preflight.concurrency` is 2 and each sandbox is allowed
`probes.cpus` = 2 and `probes.memory_mb` = 2048: **four vCPUs and 4 GB for team containers alone
at peak**, before the `docker build` steps (which those limits do not cap), four concurrent
clones and scans, and the API. On two vCPUs the sandboxes oversubscribe the box, builds hit the
300 s timeout, and every team near the deadline sees "could not be checked" — a harness failure
by our own rule. Run `m6i.large` for the setup weeks if you like (`-c instanceType=m6i.large`)
and resize before the dry run: stop, change type, start — two minutes, the address and volume
persist.

### The database is RDS, not a container

Everything of record is in Postgres: every score, every audit event, every submission, every
token hash. It gets automated backups, point-in-time restore, encryption at rest, and a final
snapshot on deletion — none of which a container on the same disk as the workloads would give it.
Only from the host's security group; never public.

The one thing not in the database is **brief artifacts** (uploaded PDFs), written under
`WORKSPACE_ROOT` — a named volume on the host. They are re-uploadable, and the extracted text
that criteria are generated from *is* in the database.

### One origin

The API refuses cross-origin requests in production (CORS is off). Caddy serves the built web
app and proxies `/api`, `/ws`, `/health` and `/ready` to the API on the compose network, so the
browser sees one hostname and the API sees no origin question. Caddy obtains and renews the
certificate itself; there is no load balancer to configure and no certificate to rotate by hand.

### Secrets

One Secrets Manager secret, `crucible/env`, a JSON object of `KEY: value`. The host's instance
role can read exactly that secret and nothing else. `deploy.sh` writes it to `/opt/crucible/.env`
(mode 600) at deploy time; it is never in user data, never in an AMI, never in the image. The API
validates it at boot and refuses to start with the missing key named.

### What the docker socket means

The `api` container mounts `/var/run/docker.sock`. That is root-equivalent on the host, and it is
the one privilege the container holds — the price of running untrusted builds in real containers
with real limits. Two consequences, both deliberate: the instance is **single-tenant** (nothing
else runs on it), and the API image runs no daemon of its own. The containers the prober starts
are the sandbox; the API is the operator of that sandbox, not a tenant of it.

### Not chosen

- **ECS / EKS** — a scheduler for one task; see above.
- **Terraform** — the codebase is TypeScript; CDK keeps the infrastructure in the same language
  and toolchain, and still yields a CloudFormation template for anyone who wants one.
- **A load balancer** — one host, and Caddy already does TLS. An ALB would add cost and a health
  check that duplicates `/ready` for no availability gain (one host behind it is still one host).
- **Building images in CI and pushing to ECR** — sound, and the compose file takes
  `CRUCIBLE_IMAGE_API` / `CRUCIBLE_IMAGE_WEB` so it can be adopted without change. For one
  event, building on the host from a git ref is one moving part fewer. `deploy.sh` does that.

---

## 2. Standing it up (once)

Prerequisites: an AWS account with credentials in your shell, Node 20+, a domain you control,
the repository reachable from the host (HTTPS with a read token, or a deploy key).

1. **Infrastructure** — CDK, in TypeScript like the rest of the codebase. `cdk synth` writes the
   CloudFormation template to `cdk.out/Crucible.template.json` if you would rather deploy that
   through CloudFormation directly; the resources are identical.
   ```
   cd deploy/aws/cdk
   npm ci
   npx cdk bootstrap                      # once per account/region
   npx cdk deploy -c domain=crucible.example.org -c hostedZone=example.org
   ```
   Without Route 53, omit `hostedZone` and create an **A record** for the domain pointing at
   the `PublicIp` output. DNS must resolve before the first deploy or Caddy cannot obtain its
   certificate. Other knobs: `-c instanceType=…`, `-c rootVolumeGb=…`, `-c dbInstanceType=…`.

2. **The database URL.** RDS manages the master password (output `DbMasterSecretArn`). Read it:
   ```
   aws secretsmanager get-secret-value --secret-id <DbMasterSecretArn> --query SecretString --output text
   ```
   and compose `postgresql://crucible:<password>@<DbEndpoint>:5432/crucible?sslmode=require`.

3. **The secret.** Fill `deploy/aws/secret.example.json` with real values and store it:
   ```
   aws secretsmanager put-secret-value --secret-id crucible/env --secret-string file://secret.json
   ```
   Generate `JWT_SECRET` and `TOKEN_REVEAL_KEY` on this machine with `openssl rand -base64 32`;
   never reuse a development value. Delete the local file afterwards.

4. **First deploy.** Connect without SSH:
   ```
   aws ssm start-session --target <instance_id>
   sudo -iu ec2-user
   export CRUCIBLE_REPO_URL=https://<token>@github.com/<org>/crucible.git
   export CRUCIBLE_SECRET_ID=crucible/env
   export SITE_ADDRESS=crucible.example.org
   git clone "$CRUCIBLE_REPO_URL" /opt/crucible/repo
   /opt/crucible/repo/deploy/aws/deploy.sh main
   ```
   The script prints `ready (<sha>)` when `/ready` answers. Then make the stack survive reboots:
   ```
   printf 'SITE_ADDRESS=crucible.example.org\n' > /opt/crucible/.deploy.env
   sudo cp /opt/crucible/repo/deploy/aws/crucible.service /etc/systemd/system/
   sudo systemctl enable crucible
   ```

5. **First sign-in.** `pnpm db:seed` is refused in production by design (known passwords). Create
   the first admin with the CLI inside the running image — the password comes from the
   environment, never an argument, and is never printed:
   ```
   cd /opt/crucible
   CRUCIBLE_USER_PASSWORD='a-long-passphrase' docker compose run --rm \
     -e CRUCIBLE_USER_PASSWORD api node apps/api/dist/db/cli/createUser.js \
     --email you@example.org --name "Your Name" --role admin
   ```
   Further staff accounts: the same command with `--role organiser|reviewer|viewer`, or the
   admin-only `POST /api/v1/governance/users` once signed in. Re-running for an address updates
   its password and role.

6. **Configuration.** Work through Part A of `docs/DRY_RUN_CHECKLIST.md` — event dates, URLs,
   flags, the Discord invite — through the admin API. Then Part B, the dry run.

---

## 3. Deploying a change

```
sudo -iu ec2-user
export CRUCIBLE_REPO_URL=… CRUCIBLE_SECRET_ID=crucible/env SITE_ADDRESS=…
/opt/crucible/repo/deploy/aws/deploy.sh <tag-or-branch>
```

What happens, in order: checkout → secret to `.env` → build both images tagged with the short
SHA → `migrate` runs alone and must succeed → `api` restarts → `web` restarts when `api` is
healthy → `/ready` polled. Migrations are idempotent and forward-only (E01-S02), so re-running a
deploy is safe.

**Rollback** is a deploy of the previous ref. Migrations do not roll back; every migration in
this repository is additive, so an older API runs against a newer schema.

**Downtime**: the API restart is a few seconds; websocket clients reconnect; a submission arriving
in that window gets a connection error and the team retries. Deploy between the dry run and the
event, not during the intake window.

---

## 4. Operating it

**Logs.** Every container writes JSON to stdout (P9.1); Docker rotates them (50 MB × 10) and the
CloudWatch agent ships them to `/crucible/containers`. On the host: `docker compose logs -f api`.
Secrets never appear in them — the redactor knows every loaded secret.

**Health.** `https://<domain>/ready` (database reachable, schema current) is what the deploy
script and the container health check use. The Health page in the app shows what is degraded,
the safety ceilings, and how teams are being reached.

**Disk.** Submission builds leave images behind; `user-data.sh` installs a daily prune of images
and build cache older than 24 h. The prober removes its own containers and images after each
probe; the prune catches what a crashed probe left. Watch `disk used_percent` in CloudWatch.

**Database.** 7-day automated backups, point-in-time restore, deletion protection on. A restore
is a new instance and a new `DATABASE_URL` in the secret, then a deploy.

**Scaling on the day.** Concurrency is configuration, not code: `preflight.concurrency`,
`batch.*_concurrency`, `llm.concurrency` in the admin API take effect on the next acquire. If the
host is short, resize the instance (stop → change type → start; the EIP and volume persist) —
minutes, and the systemd unit brings the stack back.

**Model provider.** `ANTHROPIC_API_KEY` in the secret. `LLM_CLI_BINARY` is a development
convenience and has no place on the host.

---

## 5. Local trial of the production images

```
SITE_ADDRESS=:80 docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```
(`SITE_ADDRESS` is required by the production file so a real deploy cannot forget it; `:80`
tells Caddy to serve plain HTTP.)
Then `http://localhost:8080`. This uses the repository's `.env` for everything except the
database, which the overlay supplies. It is the same image the host runs, which is the point.

---

## 6. Security notes

- No port 22. Administration is SSM Session Manager, audited by AWS, keyed to IAM.
- IMDSv2 required. The instance role reads one secret and writes logs; nothing else.
- RDS is not publicly accessible and accepts connections only from the host's security group.
- Rate ceilings (E41) are on; a tripped one appears on the Health page.
- The docker socket mount is documented above; the instance is single-tenant because of it.
- The API image runs as root because the docker socket requires it; the containers it *starts*
  run with no network, memory and PID limits, and a read-only copy of the repository.
