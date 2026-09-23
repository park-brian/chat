// Accept Bedrock model/profile IDs and same-account, same-Region ARNs.
// Syntax does not prove model availability, API compatibility, or access.
export function validModelId(id, region, account) {
  if (typeof id !== "string" || id.length > 512) return false;
  if (!id.startsWith("arn:"))
    return /^[a-z0-9][a-z0-9._:-]*$/.test(id);
  const match = /^arn:aws:bedrock:([a-z0-9-]+):([0-9]{12})?:(foundation-model|inference-profile|application-inference-profile)\/([a-z0-9][a-z0-9._:-]*)$/.exec(id);
  if (!match || match[1] !== region) return false;
  return match[3] === "foundation-model" ? !match[2] : match[2] === account;
}
