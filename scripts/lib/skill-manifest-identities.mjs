function identityTokens(value) {
  if (typeof value !== 'string') return [];
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * Model-member migration reused `nickname` for labels such as "Opus", "Code",
 * and "Gemini Pro". Those labels are valid technical terms in skill docs, not
 * persona nicknames that should be banned. Treat a nickname as a model identity
 * label when every token is already present in the member's identity fields.
 */
export function isModelIdentityNickname(member, nickname) {
  const nicknameTokens = identityTokens(nickname);
  if (nicknameTokens.length === 0) return false;

  const modelIdentityTokens = new Set(
    [
      member?.id,
      member?.catId,
      member?.name,
      member?.displayName,
      member?.modelFamily,
      member?.modelLine,
      member?.runtimeClient,
    ].flatMap(identityTokens),
  );

  return nicknameTokens.every((token) => modelIdentityTokens.has(token));
}

export function collectRosterRoutingIdentifiers(catTemplate) {
  const handleSet = new Set(Object.keys(catTemplate?.roster ?? {}).map((id) => `@${id}`));
  const nicknames = new Set();

  for (const member of Array.isArray(catTemplate?.breeds) ? catTemplate.breeds : []) {
    if (member.catId) handleSet.add(`@${member.catId}`);
    for (const variant of Array.isArray(member.variants) ? member.variants : []) {
      if (variant.catId) handleSet.add(`@${variant.catId}`);
    }

    if (
      typeof member.nickname === 'string' &&
      member.nickname.trim() &&
      !isModelIdentityNickname(member, member.nickname)
    ) {
      nicknames.add(member.nickname);
    }
  }

  return {
    handles: [...handleSet].sort((a, b) => b.length - a.length),
    nicknames: [...nicknames].sort((a, b) => b.length - a.length),
  };
}
