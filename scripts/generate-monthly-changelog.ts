import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { generateAiObjectCached } from "../lib/ai-stuff/sdk"
import { openai } from "@ai-sdk/openai"

type PRInfo = { repo: string; number: number; url: string }

const GUIDELINES = [
  "Ignore PRs that are vague",
  "Ignore PRs that update dependencies",
  "PRs that state clearly an end-user behavior change should be included",
  "PRs that don't mention specific, identifiable changes should be ignored",
  'Anything with a vague notion of "enhancement" should be ignored',
  "Link to PRs in markdown, e.g. [#123](https://github.com/tscircuit/pcb-viewer/pull/123)",
  `Output regular markdown, use "-" for bullet points`,
]

async function main() {
  const today = new Date()
  const year = today.getUTCFullYear()
  const month = today.getUTCMonth() + 1

  const prDir = path.join(process.cwd(), "pr-analysis")
  const files = fs
    .readdirSync(prDir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => {
      const d = new Date(f.replace(/\.json$/, ""))
      return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month
    })
    .sort()

  if (files.length === 0) {
    console.log(`No PR analysis found for ${year}-${month}`)
    return
  }

  const summaries: string[] = []
  const allPrs: PRInfo[] = []
  for (const file of files) {
    const prs = JSON.parse(fs.readFileSync(path.join(prDir, file), "utf8"))
    for (const pr of prs) {
      summaries.push(`- ${pr.repo} #${pr.number}: ${pr.title}`)
      allPrs.push({ repo: pr.repo, number: pr.number, url: pr.url })
    }
  }

  const prompt = `Create a concise bullet point changelog highlighting the key pull requests from ${year}-${month.toString().padStart(2, "0")}.\n${summaries.join("\n")}\n\n##Guidelines: ${GUIDELINES.map((g) => `- ${g}`).join("\n")}`

  const schema = z.object({ changelog: z.string() })
  const { object } = await generateAiObjectCached({
    schema,
    prompt,
    model: openai("o3"),
  })

  const outDir = path.join(process.cwd(), "changelogs")
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir)

  const filePath = path.join(
    outDir,
    `${year}-${month.toString().padStart(2, "0")}.md`,
  )
  const formatted = object.changelog
    .replace(/^•\s+/gm, "- ")
    .replace(/^\*\s+/gm, "- ")
    .trim()
  const linkified = linkifyChangelog(formatted, allPrs)
  fs.writeFileSync(
    filePath,
    `# Changelog ${year}-${month.toString().padStart(2, "0")}\n\n${linkified}\n`,
  )
  console.log(`Updated ${filePath}`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

function linkifyChangelog(changelog: string, prs: PRInfo[]): string {
  if (prs.length === 0) return changelog

  const slugMap = new Map<string, Map<number, PRInfo>>()
  const numberMap = new Map<number, PRInfo[]>()
  for (const pr of prs) {
    const slug = pr.repo.split("/").pop()?.toLowerCase()
    if (slug) {
      if (!slugMap.has(slug)) slugMap.set(slug, new Map())
      slugMap.get(slug)!.set(pr.number, pr)
    }
    if (!numberMap.has(pr.number)) numberMap.set(pr.number, [])
    numberMap.get(pr.number)!.push(pr)
  }

  const slugSet = new Set(slugMap.keys())

  const processed = changelog
    .split("\n")
    .map((line) => linkifyLine(line, slugMap, numberMap, slugSet))
    .join("\n")

  return processed
    .replace(/\[\[(#\d+)\]\(([^)]+)\)\]\(\2\)/g, "[$1]($2)")
    .replace(/\[([^\[\]]*?)\[(#\d+)\]\(([^)]+)\)\]\(\3\)/g, (_, prefix: string, hash: string, url: string) => {
      const trimmed = prefix.trim()
      if (trimmed.length === 0) return `[${hash}](${url})`
      return `[${trimmed} ${hash}](${url})`
    })
    .replace(
      /(\b[A-Za-z0-9._-]+) \[([A-Za-z0-9._-]+) (#\d+)\]\(([^)]+)\)/g,
      (match, outside: string, inside: string, hash: string, url: string) => {
        if (outside.toLowerCase() !== inside.toLowerCase()) return match
        return `${outside} [${hash}](${url})`
      },
    )
    .replace(
      /(\b[A-Za-z0-9._-]+) \1 \[(#\d+)\]\(([^)]+)\)/gi,
      (_, word: string, hash: string, url: string) => {
        return `${word} [${hash}](${url})`
      },
    )
}

function linkifyLine(
  line: string,
  slugMap: Map<string, Map<number, PRInfo>>,
  numberMap: Map<number, PRInfo[]>,
  slugSet: Set<string>,
): string {
  const tokens = line.match(/([^\s]+|\s+)/g)
  if (!tokens) return line

  const slugStack: string[] = []
  const pushSlug = (slug: string) => {
    const normalized = slug.toLowerCase()
    const existingIndex = slugStack.indexOf(normalized)
    if (existingIndex !== -1) slugStack.splice(existingIndex, 1)
    slugStack.push(normalized)
  }

  const result: string[] = []

  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      result.push(token)
      continue
    }

    const slugFromToken = extractSlugFromToken(token, slugSet)
    if (slugFromToken) pushSlug(slugFromToken)

    const replaced = token.replace(/#(\d+)/g, (match, numStr: string, offset: number) => {
      if (offset > 0 && token[offset - 1] === "[") return match

      const number = Number(numStr)
      let slugForNumber: string | undefined

      for (let i = slugStack.length - 1; i >= 0; i--) {
        const candidate = slugStack[i]
        if (hasLinkFor(candidate, number, slugMap)) {
          slugForNumber = candidate
          break
        }
      }

      if (!slugForNumber) {
        const slugBefore = extractSlugFromToken(token.slice(0, offset), slugSet)
        if (slugBefore && hasLinkFor(slugBefore, number, slugMap)) {
          slugForNumber = slugBefore
          pushSlug(slugBefore)
        }
      }

      const link = createLink(match, number, slugForNumber, slugMap, numberMap)

      if (link && slugForNumber) pushSlug(slugForNumber)

      return link ?? match
    })

    result.push(replaced)
  }

  return result.join("")
}

function extractSlugFromToken(token: string, slugSet: Set<string>): string | undefined {
  const slugWithHash = token.match(/#([A-Za-z][A-Za-z0-9._-]*)/)
  if (slugWithHash) {
    const slug = slugWithHash[1].toLowerCase()
    if (slugSet.has(slug)) return slug
  }

  const cleaned = token
    .replace(/^[^A-Za-z0-9._-]+/, "")
    .replace(/[^A-Za-z0-9._-]+$/, "")
    .toLowerCase()

  if (cleaned && /[a-z]/.test(cleaned) && slugSet.has(cleaned)) return cleaned

  return undefined
}

function hasLinkFor(
  slug: string,
  number: number,
  slugMap: Map<string, Map<number, PRInfo>>,
): boolean {
  return slugMap.get(slug)?.has(number) ?? false
}

function createLink(
  match: string,
  number: number,
  slug: string | undefined,
  slugMap: Map<string, Map<number, PRInfo>>,
  numberMap: Map<number, PRInfo[]>,
): string | undefined {
  if (slug) {
    const pr = slugMap.get(slug)?.get(number)
    if (pr) return `[${match}](${pr.url})`
  }

  const entries = numberMap.get(number)
  if (entries && entries.length === 1) {
    return `[${match}](${entries[0].url})`
  }

  return undefined
}

export { linkifyChangelog }
