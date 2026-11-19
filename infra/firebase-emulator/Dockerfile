# Firebase Auth Emulator for the end-to-end stack (docker-compose.e2e.yml).
# It listens on 0.0.0.0 *inside the container* so the other containers can reach it on the
# private compose network; the overlay publishes it to the host on 127.0.0.1 only.
# Project `demo-tms`: a demo project never touches a real Firebase project.
FROM node:24-alpine
RUN npm install -g firebase-tools@15.36.0 && npm cache clean --force
WORKDIR /emulator
COPY infra/firebase-emulator/firebase.json .
EXPOSE 9099
CMD ["firebase", "emulators:start", "--only", "auth", "--project", "demo-tms"]
