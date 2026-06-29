import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Dashboard from './components/Dashboard.jsx'

const isDashboard = new URLSearchParams(window.location.search).get('view') === 'dashboard'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isDashboard ? <Dashboard /> : <App />}
  </StrictMode>,
)
