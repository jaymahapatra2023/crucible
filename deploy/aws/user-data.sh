#!/usr/bin/env bash
# EC2 user data for the Crucible host (Amazon Linux 2023, x86_64 or arm64).
# Installs Docker, the compose plugin, git and the CloudWatch agent; prepares /opt/crucible.
# Secrets are NOT here: deploy.sh pulls them from Secrets Manager with the instance role.
set -euo pipefail

dnf -y update
dnf -y install docker git amazon-cloudwatch-agent jq
systemctl enable --now docker

# Docker Compose v2 as a CLI plugin.
COMPOSE_VERSION="v2.32.4"
ARCH="$(uname -m)"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH}" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Log rotation for every container, and a sane default for the daemon.
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "10" },
  "live-restore": true
}
JSON
systemctl restart docker

mkdir -p /opt/crucible
chmod 750 /opt/crucible
usermod -aG docker ec2-user

# Ship container logs and the host's own to CloudWatch (log group per service).
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'JSON'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          { "file_path": "/var/lib/docker/containers/*/*-json.log", "log_group_name": "/crucible/containers", "log_stream_name": "{instance_id}", "timezone": "UTC" },
          { "file_path": "/var/log/messages", "log_group_name": "/crucible/host", "log_stream_name": "{instance_id}" }
        ]
      }
    }
  },
  "metrics": {
    "metrics_collected": {
      "disk": { "measurement": ["used_percent"], "resources": ["/"] },
      "mem": { "measurement": ["mem_used_percent"] }
    }
  }
}
JSON
systemctl enable --now amazon-cloudwatch-agent

# Submission builds leave images and layers behind; keep the disk for the event, not for them.
cat > /etc/cron.daily/crucible-docker-prune <<'CRON'
#!/usr/bin/env bash
docker image prune -af --filter "until=24h" --filter "label!=crucible.keep" >/dev/null 2>&1 || true
docker builder prune -af --filter "until=24h" >/dev/null 2>&1 || true
CRON
chmod +x /etc/cron.daily/crucible-docker-prune
