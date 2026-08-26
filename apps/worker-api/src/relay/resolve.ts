import { z } from 'zod';
import { isPublicIp } from './target.ts';

const DnsResponseSchema = z.object({
  Status: z.number().optional(),
  Answer: z
    .array(
      z.object({
        name: z.string(),
        type: z.number(),
        data: z.string(),
      }),
    )
    .optional(),
});

export const resolvePublicAddress = async (hostname: string): Promise<string | null> => {
  const queryDns = async (
    type: 'A' | 'AAAA',
  ): Promise<readonly { type: number; data: string }[]> => {
    try {
      const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
      const res = await fetch(url, {
        headers: { accept: 'application/dns-json' },
      });
      if (!res.ok) return [];
      const json = await res.json();
      const parsed = DnsResponseSchema.safeParse(json);
      if (!parsed.success || !parsed.data.Answer) return [];
      return parsed.data.Answer;
    } catch {
      return [];
    }
  };

  const aAnswers = await queryDns('A');
  for (const answer of aAnswers) {
    if (answer.type === 1 && isPublicIp(answer.data)) {
      return answer.data;
    }
  }

  // Only query AAAA if A returned nothing
  if (aAnswers.length === 0) {
    const aaaaAnswers = await queryDns('AAAA');
    for (const answer of aaaaAnswers) {
      if (answer.type === 28 && isPublicIp(answer.data)) {
        return answer.data;
      }
    }
  }

  return null;
};
