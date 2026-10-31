export function draftNotice(c: { brand: string; url: string; surface: string; why: string; score: number }): string {
  return [
    `DRAFT, NOT SENT. Requires human approval and counsel review before any real use.`,
    ``,
    `To the ${c.surface} trust and safety team,`,
    ``,
    `On behalf of ${c.brand}, we ask you to review the following candidate flagged for review:`,
    c.url,
    ``,
    `Why it was flagged: ${c.why} (model score ${c.score.toFixed(2)}).`,
    ``,
    `If your review confirms this content misuses ${c.brand}'s marks or misleads customers, please remove it under your policies.`,
  ].join('\n')
}
