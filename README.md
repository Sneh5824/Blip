# Blip

Blip is a real-time, anonymous, timed collaboration platform for fast chat and coding sessions.

No sign-up, no accounts, and room data is removed automatically when time runs out.

## Highlights

- Anonymous identities with random display names
- Two room modes:
  - Chat
  - Coding (shared Monaco editor)
- Rich real-time chat:
  - replies and reactions
  - typing indicators
  - image/file attachments
  - voice notes
  - URL link preview side panel (resizable)
- Public join flow:
  - system-provided public rooms (`PUB10M`, `PUB20M`)
  - no invitation code needed
  - no host role in public rooms
  - room names are randomly generated
- Private room controls:
  - invite link copy
  - host export snapshot
  - host end room
- Fully responsive UI improvements for mobile and desktop

## USP (Unique Selling Proposition)

Blip's strongest differentiator is privacy-first, zero-friction collaboration with timed ephemeral rooms.

- Instant anonymous entry:
  users can collaborate without account creation or onboarding friction.
- Time-boxed by architecture:
  rooms and room data are automatically destroyed after expiry, enforcing ephemeral communication.
- Dual collaboration surface in one product:
  real-time chat and live coding workspace are available in the same room experience.
- Built-in hostless public mode:
  system-managed public rooms (`PUB10M`, `PUB20M`) allow open community collaboration without invitations.
- Lightweight but feature-rich communication:
  attachments, voice notes, reactions, replies, typing indicators, and link previews are included by default.

## Public Room Model

Public rooms are not user-created.

The backend maintains two rotating public chat rooms:

- `PUB10M` (10 minutes)
- `PUB20M` (20 minutes)

When they expire, they are recreated automatically with fresh random names.

## Applications of This Project

Blip is useful in scenarios where fast, temporary collaboration is needed without account setup.

- DSA practice groups: share problem links, discuss approaches, and quickly spin up coding rooms.
- Pair programming sessions: collaborate on code in real time for interviews or debugging.
- Classroom labs and workshops: create short, controlled-time discussion/coding spaces.
- Hackathon coordination: use public rooms for open brainstorming and private rooms for team work.
- Interview prep: simulate timed coding rounds with live chat and synchronized editor.
- Community Q and A corners: time-boxed public chat rooms for quick help sessions.

### Real-World Application and Usage

Blip can be used in real environments where teams need instant, low-overhead collaboration.

- Universities and colleges:
  live coding labs, exam practice discussions, mentor office-hour help rooms.
- EdTech and coding bootcamps:
  session-based learning cohorts with temporary rooms for each topic or batch.
- Developer communities:
  open help rooms for debugging and concept discussion without permanent account requirements.
- Interview preparation platforms:
  timed mock interview rooms with coding editor + chat for candidate and mentor.
- Internal engineering teams:
  ad-hoc incident war rooms, quick architecture reviews, and short debugging swarms.
- Hackathons and events:
  temporary team channels and public topic rooms during constrained event windows.

### Why This Fits Real-Time Workflows

- Fast setup:
  users can start collaborating in seconds.
- Time bounded sessions:
  ideal for standups, reviews, interview rounds, and classroom slots.
- Data minimization:
  automatic cleanup helps for privacy-focused and temporary discussions.
- Multi-device support:
  works across mobile and desktop for practical on-the-go collaboration.

## Advantages

- Low friction onboarding:
  no signup, no profiles, instant entry.
- Ephemeral by design:
  data is deleted automatically on room expiry.
- Real-time collaboration:
  chat, typing, reactions, cursor sync, and code sync happen live.
- Flexible usage model:
  both private invite-based rooms and public hostless rooms are supported.
- Better communication quality:
  supports attachments, voice notes, and rich link previews.
- Mobile + desktop friendly:
  responsive UI with adaptive layouts and controls.
- Lightweight architecture:
  simple Node + Socket.IO + Redis stack that is easy to run locally.

## Future Improvements

- Public room continuity:
  auto-move users to fresh cycle when a public room expires.
- Capacity and sharding:
  max users per public room with overflow room balancing.
- Abuse prevention:
  spam filtering and temporary mute policies (basic rate limits are already in place).
- Better moderation:
  report/hide tools for public rooms.
- Presence enhancements:
  richer online status, idle indicators, and room activity heat.
- Persistent optional exports:
  optional downloadable summaries for non-sensitive workflows.
- Production deployment hardening:
  container sandbox for code execution, health probes, centralized logging, metrics.
- Conflict-free collaborative editing:
  replace whole-document sync with a CRDT (e.g. Yjs) so simultaneous edits merge.
- Authentication extension (optional mode):
  support org-based verified rooms while preserving anonymous default mode.

## Potential Academic Scope

This project can be extended as a mini-project or major-project base in areas like:

- real-time systems design
- scalable WebSocket architecture
- ephemeral data lifecycle and cleanup policies
- collaborative editing UX patterns
- distributed cache usage with Redis

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 14, React, Tailwind CSS |
| Realtime | Socket.IO |
| Editor | @monaco-editor/react |
| Backend | Node.js, Express |
| Data | Redis |

## Repository Structure

```text
.
|-- backend/
|   |-- server.js          REST API, admin API, code-run endpoint, startup
|   |-- socket.js          Socket.IO events (all identity bound server-side)
|   |-- sessionManager.js  Redis data layer (rooms, participants, messages, reactions, code)
|   |-- roomLifecycle.js   expiry timers, host grace period, restart recovery, system public rooms
|   |-- codeRunner.js      async, time/output-limited code execution
|   |-- rateLimit.js       in-memory rate limiting
|   `-- test/              end-to-end integration tests
|-- frontend/
|   |-- components/
|   |-- lib/
|   |-- pages/
|   `-- styles/
|-- docker-compose.yml
`-- README.md
```

## Local Setup

### 1. Clone

```bash
git clone https://github.com/Sneh5824/Mini-Project.git
cd "Mini Project"
```

### 2. Install dependencies

```bash
cd backend
npm install

cd ../frontend
npm install
```

### 3. Start Redis

Docker:

```bash
docker compose up -d
```

Or local:

```bash
redis-server
```

### 4. Start backend

```bash
cd backend
npm run dev
```

Backend: http://localhost:5001

### 5. Start frontend

```bash
cd frontend
npm run dev
```

Frontend: http://localhost:3000

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the free-tier setup (Vercel + Render + Upstash), environment variables, limits and troubleshooting.

## Configuration

Backend (`backend/.env`, template in [`backend/.env.example`](backend/.env.example)):

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | (unset) | `production` enables strict config validation, trust-proxy, and turns code execution off by default |
| `PORT` | `5001` | HTTP / Socket.IO port |
| `HOST` | `0.0.0.0` in production, all interfaces locally | Interface to bind |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `FRONTEND_URL` | localhost:3000 | Allowed CORS origin(s), comma-separated; required in production |
| `ADMIN_PASSWORD` | (unset) | Enables `/admin`; admin login is disabled without it |
| `HOST_GRACE_MS` | `45000` | How long a private room waits for a disconnected host before ending |
| `CODE_EXECUTION` | on in dev, off in production | Enables `/api/run` |
| `CODE_EXEC_MAX_CONCURRENT` | `4` | Parallel code runs before the runner answers "busy" |
| `ROOM_CREATE_LIMIT_PER_MIN` | `20` | Room creations allowed per IP per minute |
| `ROOM_ATTACHMENT_BUDGET_MB` | `20` | Attachment storage per room |
| `CODE_FLUSH_MS` | `2000` | Max delay before editor content is written to Redis |
| `TRUST_PROXY` | `1` in production | Proxy hops in front of the app (for client IPs) |

Frontend: `NEXT_PUBLIC_BACKEND_URL` (default `http://localhost:5001` in development only; required for production builds on Vercel). Template: [`frontend/.env.example`](frontend/.env.example).

## Testing

The backend has an end-to-end suite that boots the real server against Redis and drives it over HTTP and Socket.IO (auth, host grace period, attachments, URL validation, reactions under concurrency, TTLs, code execution, admin API, restart recovery). It never flushes Redis, but point it at a throwaway instance anyway:

```bash
redis-server --port 6390
cd backend
TEST_REDIS_URL=redis://127.0.0.1:6390 npm test
```

The C++ test is skipped automatically when the machine's `g++` cannot link a program.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/rooms` | Create private room |
| GET | `/api/rooms/:roomId` | Fetch room metadata / validate room |
| GET | `/api/public-rooms` | List active public rooms (system + admin-created) |
| GET | `/api/rooms/:roomId/attachments/:id` | Download a chat attachment (images/audio inline, everything else as a download) |
| POST | `/api/run` | Execute code; caller must be a participant of an active coding room (`roomId`, `guestId`) |
| GET | `/health` | Health check |
| POST | `/api/admin/login` | Exchange `ADMIN_PASSWORD` for a 1-hour bearer token (rate limited) |
| GET | `/api/admin/stats` | Active rooms, public rooms, participants, messages |
| GET | `/api/admin/public-rooms` | List public rooms |
| POST | `/api/admin/public-rooms` | Create a public room (`timeout`, `roomType`, optional `roomName` / `roomId`; 409 if the id is taken) |
| DELETE | `/api/admin/public-rooms/:roomId` | Remove a public room (system rooms restart with a fresh cycle) |

## Identity Model

- Each browser has a private `guestId` (localStorage). It is only ever sent to the server and decides who the host is.
- The server derives a public `userId` per room (`sha256(roomId:guestId)`) and uses only that in anything it broadcasts (participants, messages, reactions, cursors). Other users therefore cannot learn or spoof the host's identity.
- After `join_room`, the server binds room and identity to the socket; later events ignore any `roomId` / `guestId` the client sends.

## Socket Events

### Client -> Server

| Event | Purpose |
| --- | --- |
| `join_room` | Join active room (`roomId`, `guestId`, `displayName`); re-sent automatically after reconnects |
| `leave_room` | Leave the current room |
| `send_message` | Send text/attachment/reply message (rate limited) |
| `typing_status` | Update typing indicator |
| `toggle_reaction` | React/unreact to message (fixed emoji set) |
| `code_update` | Sync coding editor text (max 200KB) |
| `language_update` | Change the shared editor language |
| `cursor_update` | Broadcast collaborative cursor/selection |
| `share_problem` | Share an http(s) problem link (host only in private rooms) |
| `end_room` | End room (host only) |

### Server -> Client

| Event | Purpose |
| --- | --- |
| `room_joined` | Initial room payload, incl. `selfUserId` and `hostStatus` |
| `receive_message` | New message delivered |
| `typing_update` | Typing status changes |
| `reaction_updated` | Message reaction updates |
| `code_updated` | Shared code changes |
| `language_updated` | Shared editor language changed |
| `cursor_updated` | Remote cursor update |
| `cursor_removed` | Remove remote cursor |
| `participants_update` | Participant list updates |
| `user_joined` | Join system message |
| `user_left` | Leave system message |
| `problem_shared` | Problem link update |
| `host_status` | Host disconnected (with `graceEndsAt`) or reconnected |
| `room_expired` | Room expired and cleaned up |
| `room_error` | Joining failed (fatal) |
| `action_error` | An action was rejected (non-fatal, shown as a toast) |

## Redis Key Schema

Every per-room key expires in Redis at the room's `expiresAt`, so data is removed even if the backend is down when a room ends.

| Key | Type | Description |
| --- | --- | --- |
| `room:{roomId}` | String | Room metadata (JSON) |
| `participants:{roomId}` | Hash | `guestId` -> participant JSON |
| `messages:{roomId}` | List | Chat history (last 300 messages) |
| `msgids:{roomId}` | Set | Message ids, used to validate reactions |
| `reactions:{roomId}` | Hash | `messageId` -> `{ emoji: [userId] }` |
| `code:{roomId}` | String | Shared code content (written at most every `CODE_FLUSH_MS`) |
| `att:{roomId}:{id}` | String | Attachment blob (base64 JSON); messages only carry metadata |
| `atts:{roomId}` | Set | Attachment ids, for cleanup when the room ends |
| `attbytes:{roomId}` | String | Bytes of attachments stored, for the per-room budget |
| `rooms:expiry` | Sorted set | roomId scored by `expiresAt`; rebuilds timers after a restart |
| `rooms:public` | Sorted set | Public roomIds, so listing does not scan private rooms |

## Code Execution Safety

`/api/run` executes code on the backend machine. It is **off by default when `NODE_ENV=production`**. Guards in place:

- only participants of an active coding room can run code; per-IP rate limit and a concurrency cap
- asynchronous execution (the server stays responsive), 10s run / 30s compile timeouts that kill the whole process tree, 64KB output cap
- every run gets its own temp directory, and child processes get a minimal environment (no `ADMIN_PASSWORD`, `REDIS_URL`, ...)
- JavaScript/TypeScript run under Node's permission model: no file access outside the run directory, no child processes

Python, Java, C++, Go and Rust programs still run with the backend user's OS permissions. For any public deployment, either set `CODE_EXECUTION=off` or run the backend inside a locked-down container.

## Notes

- Public room IDs are fixed for routing convenience, but names are random per cycle.
- Room data is ephemeral and deleted on expiry.
- If the host of a private room disconnects, the room stays open for `HOST_GRACE_MS` so a refresh or network blip does not end it.
- Code sync is whole-document, last-write-wins: two people typing at the same moment can overwrite each other's latest keystrokes.
- Some external links may block iframe preview due to browser security headers.

## Troubleshooting

### Backend does not start

- Ensure Redis is running
- Reinstall and retry:

```bash
cd backend
npm ci
npm run dev
```

### Frontend does not start

```bash
cd frontend
npm ci
npm run dev
```

### Tailwind at-rule warning in VS Code

This is editor lint noise only. Add:

```json
{
  "css.lint.unknownAtRules": "ignore"
}
```

## License

Academic and personal project use.
