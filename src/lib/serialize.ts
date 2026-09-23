export function omitPasswordHash<T extends { password_hash: string }>(user: T) {
  const { password_hash: _password_hash, ...safeUser } = user;
  return safeUser;
}
