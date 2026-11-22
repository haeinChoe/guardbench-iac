# Stand-in for every image the experiment layer cannot pull locally: the Backend and Demo AI
# images and the SageMaker serving container. SageMaker starts the container with `serve`.
FROM python:3.11-slim
COPY mock_api.py /opt/stub/mock_api.py
RUN printf '#!/bin/sh\nexec python /opt/stub/mock_api.py\n' > /usr/local/bin/serve \
    && chmod 0755 /usr/local/bin/serve
CMD ["python", "/opt/stub/mock_api.py"]
