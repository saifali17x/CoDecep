declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; role: string }
    }
  }
}

// Make this file a module so the global augmentation is applied.
export {}
