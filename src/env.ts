try {
  process.loadEnvFile();
} catch {
  // .env is optional — deployed environments provide these vars directly
}
