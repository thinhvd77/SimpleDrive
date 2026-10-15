// Keep loopback-origin aliases limited to the explicit development entry point.
process.env.NODE_ENV = 'development';
await import('./main.js');
export {};
