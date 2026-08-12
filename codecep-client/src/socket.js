import { io } from 'socket.io-client'
import { API_BASE } from './lib/config'

// Same origin as the HTTP API — the socket connects to the same server (gap #61).
// An EMPTY API_BASE is the single-app production build (see lib/config.js): call
// io() with NO url so socket.io targets the page's own origin. `io("")` is not
// the same thing — it is a falsy url that socket.io does not read as "here".
const socket = API_BASE ? io(API_BASE) : io()
export default socket
