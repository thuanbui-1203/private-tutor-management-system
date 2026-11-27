# Firebase Auth + Realtime Database emulators for the end-to-end stack (docker-compose.e2e.yml).
# They listen on 0.0.0.0 *inside the container* so the other containers can reach them on the
# private compose network; the overlay publishes them to the host on 127.0.0.1 only.
# Project `demo-tms`: a demo project never touches a real Firebase project.
FROM node:24-alpine
# The Realtime Database emulator is a Java program.
RUN apk add --no-cache openjdk21-jre-headless
RUN npm install -g firebase-tools@15.36.0 && npm cache clean --force
# Download the database emulator now, not at every start.
RUN firebase setup:emulators:database
WORKDIR /emulator
COPY infra/firebase-emulator/firebase.json .
COPY infra/firebase/database.rules.json ./database.rules.json
EXPOSE 9099 9002
CMD ["firebase", "emulators:start", "--only", "auth,database", "--project", "demo-tms"]
