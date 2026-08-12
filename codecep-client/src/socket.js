import { io } from 'socket.io-client'
import { API_BASE } from './lib/config'

// Same origin as the HTTP API — the socket connects to the same server (gap #61).
const socket = io(API_BASE)
export default socket
