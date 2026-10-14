# Plan: Form field length limits report

## 1. Goal
A file `report.md` that tells the team what length limits the sign-up and profile forms should enforce for six fields: email address, website URL, domain name, password, phone number and display name. For each field the report gives the recommended limit, the reason, and a linked primary source placed next to the claim. The report also corrects the current email limit of 320 and comments on the current URL cap of 2,048.

## 2. Done means
- `report.md` exists in the working directory.
- There is one section per field, in this order: Email, Website URL, Domain name, Password, Phone number, Display name. Each section contains these three labelled lines: **Recommended limit**, **Basis**, **Sources**.
- A summary table near the top lists all six fields with their limits. The numbers in it match section 3 exactly.
- There are at least 10 distinct source URLs. Check with: `grep -oE 'https?://[^) >]+' report.md | sort -u | wc -l` (result must be ≥ 10).
- Every citation is a markdown link in the same sentence or bullet as the claim it supports. No citations are gathered only in a list at the end. A references list at the end is optional.
- Every linked page was opened and checked to contain the cited claim.
- The report says plainly that 320 is wrong and that 254 is correct, and explains why.

## 3. Fixed facts (do not change these)
**Email:** total 254 characters, local part 64 octets, domain 253 (textual form, see Domain).
- Basis: RFC 5321 §4.5.3.1 sets local part 64 octets, domain 255 octets, and path 256 octets. The path includes the angle brackets, so the address itself is at most 254.
- RFC 3696 §3 originally said 320. Errata ID 1690 corrects it to 254. This explains where the team's 320 came from.
- Limits are in octets. With SMTPUTF8 (RFC 6531), non-ASCII characters take several octets, so check UTF-8 byte length as well as character count.

**Website URL:** keep 2,048 characters as the policy cap.
- Basis: RFC 3986 sets no maximum.
- RFC 9110 §4.1 recommends that senders and recipients support URIs of at least 8,000 octets.
- 2,048 matches the old Internet Explorer limit (Microsoft documentation) and the sitemaps.org URL limit.
- Say it is a practical choice and not a standard. Note that 8,000 is the alternative if users report rejected URLs.

**Domain name:** whole name 253 characters (no trailing dot), each label 1–63 octets.
- Basis: RFC 1035 §2.3.4 gives labels 63 octets and names 255 octets in wire format. Wire format includes length bytes, so the textual maximum is 253.
- RFC 1123 §2.1 covers letter-digit-hyphen labels. RFC 2181 §11 covers the length rules.
- For internationalized names, apply the limits to the A-label (`xn--`) form (RFC 5890/5891). Do not apply them to the Unicode form.

**Password:** minimum 15 characters, or 8 only where MFA is always required. Maximum accepted is 128 characters. Never truncate silently. Reject longer input with a clear message.
- Basis: NIST SP 800-63B (Revision 4) sets minimum 15 for single-factor passwords and 8 when the password is used as part of MFA. It says verifiers should permit a maximum of at least 64.
- Hashing:
  - bcrypt uses only the first 72 bytes of input. Longer passwords are silently truncated. Cite the OpenBSD bcrypt documentation or the Provos & Mazières paper, and the OWASP Password Storage Cheat Sheet.
  - PBKDF2-HMAC pre-hashes keys longer than the hash block size (RFC 2104 §2; RFC 8018). Very long inputs cost CPU, so a server-side cap guards against denial of service.
  - Recommend Argon2id (RFC 9106; OWASP).
  - If bcrypt stays, either keep the 72-byte limit visible to users or pre-hash with care, following OWASP guidance.
  - 128 characters of UTF-8 can be up to 512 bytes. State this and say the cap prevents abuse.

**Phone number:** store in E.164 form: "+" followed by at most 15 digits. Allow up to 32 characters of raw input for spaces, dashes and brackets, then normalise. Keep extensions in a separate field.
- Basis: ITU-T Recommendation E.164 sets a maximum of 15 digits. libphonenumber may be mentioned for validation.

**Display name:** 64 user-perceived characters (grapheme clusters, Unicode UAX #29), and also no more than 256 UTF-8 bytes. Normalise to NFC.
- Basis: there is no standard length. This is a product decision. RFC 8266 (PRECIS nicknames) covers normalisation, and UAX #29 explains why character counts differ from code-point and byte counts.
- The byte cap blocks combining-mark abuse.

Write the report date as the day of writing.

## 4. Order of work
1. Open each source listed in section 3 and record its URL plus the exact sentence or section that supports the claim. Output: notes file `sources.txt`. Prefer rfc-editor.org, pages.nist.gov, itu.int, unicode.org, owasp.org and openbsd.org. For erratum 1690, use the rfc-editor.org errata page.
2. Write the summary table and a short introduction stating the scope and the correction of 320 to 254. Output: top of `report.md`.
3. Write the six field sections in order. Each needs a limit, a basis and inline links. Output: full draft.
4. Add a short "Implementation notes" section covering four points: count bytes vs characters, validate on the server as well as the client, use database column sizes at least as large as the limits, and reject input rather than truncate it.
5. Run the checks in section 2. Fix any failures. Output: final `report.md`.

## 5. Traps
- **Repeating 320 as correct.** It comes from the uncorrected RFC 3696. Use 254 and cite the erratum.
- **Using 255 as the domain limit in a text field.** That number is the wire format. The text limit is 253.
- **Mixing characters, code points and bytes.** RFCs count octets. Say which unit applies in every limit.
- **Citing a stale NIST version** (for example, Rev 3 with an 8-character minimum) as current. Confirm on pages.nist.gov which revision is final and cite that one. If Rev 4 is not final, say so and give both.
- **Claiming the HTTP standard caps URLs at 2,048.** It does not. That number is a browser and sitemap convention.
- **Citing a blog post when a primary source exists.** Blogs may appear only as additional sources, never as the only support for a claim.
- **Using a link without opening it.** Unverified or 404 links do not count toward the 10.
- **Changing numbers mid-draft.** Section 3 governs. If a source contradicts it, note the conflict in the report and keep the decided number unless the source is the primary standard itself.
- **Truncating at 72 bytes.** Never recommend silent truncation of passwords.

## 6. When to stop
Stop when every check in section 2 passes once. Then report the file path, the source count, and any source that could not be verified or that conflicted with section 3. Do not keep polishing the wording. If a primary source cannot be reached after two tries, cite the best official mirror, record the problem in the report, and move on.
