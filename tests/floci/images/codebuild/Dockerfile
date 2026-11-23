# Build image for the Runner CodeBuild project. It carries what the buildspec calls (bash, git,
# curl, tar, pip, aws) and a Backend repository fixture, which the test selects with a
# BACKEND_REPO_URL override at StartBuild. The fixture is copied in as a bare repository.
# This is AWS CLI v1 (pip); the real CodeBuild image has v2. The buildspec only uses `aws s3 cp`,
# which behaves the same in both.
FROM python:3.11-slim@sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir awscli==1.46.3
COPY backend.git /fixture/backend.git
