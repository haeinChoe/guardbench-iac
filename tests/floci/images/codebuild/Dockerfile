# Build image for the Runner CodeBuild project. It carries what the buildspec calls (bash, git,
# curl, tar, pip, aws) and a Backend repository fixture, which the test selects with a
# BACKEND_REPO_URL override at StartBuild. The fixture is copied in as a bare repository.
FROM python:3.11-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir awscli
COPY backend.git /fixture/backend.git
