
#!/usr/bin/env bash
# git-ssh-push.sh
# Initialize repo, create commit, link SSH remote, and push to main.

set -euo pipefail

REMOTE_URL="${1:-}"

if [[ -z "${REMOTE_URL}" ]]; then
  echo "❌ Remote SSH URL is required."
  echo "Usage: $0 git@github.com:username/repo.git"
  exit 1
fi

# 1) Verify SSH URL format
if [[ ! "${REMOTE_URL}" =~ ^git@.+:.+\.git$ ]]; then
  echo "⚠️  Remote does not look like a standard SSH URL (e.g., git@github.com:username/repo.git)."
  echo "Provided: ${REMOTE_URL}"
fi

# 2) Check SSH agent and keys
if ! ssh-add -l >/dev/null 2>&1; then
  echo "🔑 Starting ssh-agent and attempting to add default key (~/.ssh/id_ed25519 or ~/.ssh/id_rsa)..."
  eval "$(ssh-agent -s)"
  if [[ -f "${HOME}/.ssh/id_docfinder" ]]; then
    ssh-add "${HOME}/.ssh/id_docfinder" || true
  elif [[ -f "${HOME}/.ssh/id_rsa" ]]; then
    ssh-add "${HOME}/.ssh/id_rsa" || true
  else
    echo "⚠️  No SSH key found. You can generate one with:"
    echo "    ssh-keygen -t ed25519 -C \"your_email@example.com\""
  fi
fi

# 3) Ensure Git is installed
if ! command -v git >/dev/null 2>&1; then
  echo "❌ Git is not installed. Install via Xcode command line tools:"
  echo "    xcode-select --install"
  exit 1
fi

# 4) Set user.name and user.email if missing
GIT_USER_NAME="$(git config --global user.name || true)"
GIT_USER_EMAIL="$(git config --global user.email || true)"

if [[ -z "${GIT_USER_NAME}" || -z "${GIT_USER_EMAIL}" ]]; then
  echo "👤 Git user not fully configured."
  read -r -p "Enter your Git user.name: " NAME_INPUT
  read -r -p "Enter your Git user.email: " EMAIL_INPUT
  git config --global user.name "${NAME_INPUT}"
  git config --global user.email "${EMAIL_INPUT}"
  echo "✅ Set global Git user to ${NAME_INPUT} <${EMAIL_INPUT}>"
fi

# 5) Initialize repo if needed
if [[ ! -d ".git" ]]; then
  echo "📁 Initializing Git repository..."
  git init
fi

# 6) Create a .gitignore if none exists (optional convenience)
if [[ ! -f ".gitignore" ]]; then
  cat > .gitignore <<'EOF'
# macOS
.DS_Store

# Node
node_modules/

# Python
__pycache__/
*.pyc

# Logs
*.log

# Env
.env
.env.local
EOF
  echo "📝 Created basic .gitignore"
fi

# 7) Stage and commit
if [[ -z "$(git status --porcelain)" ]]; then
  echo "ℹ️  Working tree clean. Nothing to commit."
else
  echo "➕ Staging and committing changes..."
  git add .
  if git rev-parse --verify HEAD >/dev/null 2>&1; then
    git commit -m "chore: update initial files"
  else
    git commit -m "chore: initial commit"
  fi
fi

# 8) Ensure branch is 'main'
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [[ "${CURRENT_BRANCH}" != "main" ]]; then
  echo "🌿 Renaming branch to 'main'..."
  git branch -M main
fi

# 9) Add remote 'origin' (replace if exists)
if git remote get-url origin >/dev/null 2>&1; then
  EXISTING_URL="$(git remote get-url origin)"
  if [[ "${EXISTING_URL}" != "${REMOTE_URL}" ]]; then
    echo "🔁 Updating remote 'origin' from ${EXISTING_URL} to ${REMOTE_URL}..."
    git remote remove origin
    git remote add origin "${REMOTE_URL}"
  else
    echo "✅ Remote 'origin' already set to ${REMOTE_URL}"
  fi
else
  echo "🔗 Adding remote 'origin' → ${REMOTE_URL}"
  git remote add origin "${REMOTE_URL}"
fi

# 10) Test SSH connectivity to host (best-effort)
REMOTE_HOST="$(echo "${REMOTE_URL}" | sed -E 's|git@([^:]+):.*|\1|')"
echo "🔍 Testing SSH connectivity to ${REMOTE_HOST}..."
ssh -T "git@${REMOTE_HOST}" || echo "ℹ️  SSH test completed (some hosts print a warning for first-time connections)."

# 11) Push to remote and set upstream
echo "📤 Pushing to remote 'origin' on 'main'..."
git push -u origin main


