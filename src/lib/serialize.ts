export function omitPasswordHash<T extends { password_hash: string }>(user: T) {
  const { password_hash: _password_hash, ...safeUser } = user;
  return safeUser;
}

/**
 * Converts BigInt fields (Prisma maps Postgres BIGINT columns to JS bigint,
 * which Express's res.json()/JSON.stringify cannot serialize on its own) to
 * plain numbers for API responses. Safe here because attachment sizes are
 * bounded well under Number.MAX_SAFE_INTEGER (~9x10^15 bytes) by
 * ATTACHMENT_MAX_FILE_SIZE_MB and plan storage caps.
 */
export function serializeAttachment<T extends { size_bytes: bigint }>(attachment: T) {
  return { ...attachment, size_bytes: Number(attachment.size_bytes) };
}
