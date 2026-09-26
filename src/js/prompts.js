// Prompts LLM — extraídos verbatim do CLI (bin/rireki-tailor + bin/gen-pdf).
// O prompt ATS usa o arquivo data/PROMPT_ATS.md (mantém sincronia com o repositório).

let atsBaseCache = null;

async function loadAtsBase() {
  if (atsBaseCache !== null) return atsBaseCache;
  const r = await fetch('data/PROMPT_ATS.md');
  if (!r.ok) throw new Error('Falha ao carregar data/PROMPT_ATS.md: HTTP ' + r.status);
  atsBaseCache = await r.text();
  return atsBaseCache;
}

function buildAtsPrompt(masterCv, lang, jobDesc) {
  const isPt = lang === 'pt';
  return `${atsBaseCache}

---

## LANGUAGE

Generate the CV IN ${isPt ? 'PORTUGUESE (PT-BR)' : 'ENGLISH (EN)'}. All sections, headers, bullet points, and the professional summary must be in ${isPt ? 'Portuguese' : 'English'}.

---

## MASTER CV

Below is the complete master CV. ONLY use information that exists here. NEVER invent skills, experiences, or projects that are not present in this document.

${masterCv}

---

## JOB DESCRIPTION

Below is the job description to optimize the CV for. Extract keywords, map to the master CV, select and reorder the most relevant content.

${jobDesc}

---

Generate the tailored ATS-optimized CV based on the instructions above. Output ONLY the CV markdown, no commentary.`;
}

function buildCoverPrompt(cvOut, lang, jobDesc, pitch) {
  const isPt = lang === 'pt';
  let p = `You are an expert career coach and copywriter specialized in software engineering job applications.

## Your Task

Given a **tailored CV** (already optimized for a specific role) and the **original job description**, write a personal pitch/presentation for the candidate to submit alongside their application.

This is the section where the candidate answers: **"Why this role is for you"** and can freely add anything relevant (presentations, repositories, portfolio links, etc.).

## Output Format

Generate the cover content in this structure:

\`\`\`markdown
# Cover — [Candidate Name] → [Role Title at Company]

## About Me

[1-2 paragraphs. A concise, authentic opening that connects the candidate's background to the role. Use a professional but personal tone. Mention what attracts the candidate to this specific role/company. Do NOT repeat the CV — complement it.]

## Why This Role

- [Bullet: specific skill/experience that directly matches a job requirement]
- [Bullet: project or achievement that proves capability for this role]
- [Bullet: technical fit — stack, domain, or methodology alignment]
- [Bullet: soft fit — team size, remote culture, mission, or growth opportunity]
- [Bullet: any additional differentiator — open source, publications, community work]

## Relevant Links & References

[Only include if the candidate has relevant material mentioned in the CV or that would support this application]

- GitHub: relevant repos or organizations
- Portfolio: projects, talks, or articles
- Anything else that strengthens the application
\`\`\`

## Language

Write IN ${isPt ? 'PORTUGUESE (PT-BR)' : 'ENGLISH (EN)'}.

## Core Rules

1. Base everything on the CV below. If a skill, project, or experience is NOT in the CV, do NOT mention it.
2. Use the job description to understand what the employer values — align the pitch to their language and priorities.
3. Be concise. The whole cover should be scannable in 30 seconds.
4. Tone: confident but not arrogant. Professional but human.
5. Include a placeholder section for extra material (links, repos, presentations) — the candidate can fill or remove it.

---

## TAILORED CV

${cvOut}

---

## JOB DESCRIPTION

${jobDesc}

---

Generate the cover.md content now. Output ONLY the markdown, no commentary.`;
  if (pitch && pitch.trim()) {
    p += `

---

## PERSONAL PITCH INSTRUCTIONS

The candidate has provided the following instructions/guidance for the pitch. Incorporate them into the cover content, following the tone, highlights, and expectations described below:

${pitch}`;
  }
  return p;
}

function buildTexPrompt(cvOut, templateTex) {
  return `You are a LaTeX CV formatter. Fill a markdown CV into a LaTeX template.

## Step 1: Reverse-Engineer the Template

Study the LaTeX template below. **IGNORE all sample/placeholder content** — names, emails, skills, job titles, universities, dates, taglines, bios, all of it is fake and irrelevant. Focus ONLY on extracting the **structural skeleton**, using whatever commands and section names THIS template actually defines (do not assume any particular naming convention):

- **Custom commands:** Scan the preamble for every \\newcommand / \\renewcommand / \\newenvironment relevant to content (header fields, section headings, list items, entry types, dividers, etc.). List each one you find with its exact name and argument count.
- **Section order and hierarchy:** Which content sections exist in the template body (e.g. header, skills, education, experience, projects, languages, awards, certifications — whatever this template actually has), and in what order?
- **Layout pattern per section:** For each section, what is the exact sequence of commands/environments used to render its entries (e.g. wrapped in a multi-column environment, one command per entry, an itemize block nested inside an entry, a rule/divider between entries)? Describe the pattern generically, based only on what you observe in this specific template, not on any other template you may have seen before.
- **Header structure:** How is the person's name, tagline/title, and contact info (email, phone, links, location) declared and rendered?
- **Overall structure:** preamble -> \\begin{document} -> header setup -> sections -> \\end{document}

## Step 2: Fill the Skeleton with CV Content

Now take the CV content (markdown below) and adapt it to the skeleton you just extracted:

- Map each CV section to the closest matching section pattern found in the template. Use the **exact same commands and layout patterns** you identified in Step 1 — do not substitute commands from a different template style.
- Replace all sample data with the actual CV data (name, tagline, contact info, bio/summary, skills, experience entries, education, languages, etc.).
- If the CV has a section with no equivalent in the template (e.g. Projects), reuse the closest existing entry-list pattern from the template (e.g. whatever pattern is used for a similar list-of-entries section) rather than inventing new formatting.
- If the template skeleton has a section not present in the CV content, **omit it entirely**.
- If the CV has more entries in a section than the template's sample showed, repeat the same per-entry pattern for each additional entry (and its divider/separator, if the template uses one).

## Rules

- **Do NOT invent new LaTeX commands.** Use only the macros/environments actually defined in this template's preamble.
- **Escape special LaTeX characters:** &, %, $, #, _, {, } must be properly escaped.
- **Keep ALL preamble code exactly as-is** (\\usepackage, \\definecolor, \\newcommand, \\renewcommand, etc.) — do not modify, remove, or reformat it.
- **Preserve the template's own separators/dividers** between entries exactly as it uses them, if it uses them.
- **Output ONLY the complete, valid .tex source.** No commentary, no markdown wrappers, no code fences. Must compile with pdflatex.

---

## LATEX TEMPLATE

${templateTex}

---

## CV CONTENT (Markdown)

${cvOut}

---

Generate the complete .tex file now. Output ONLY the LaTeX source.`;
}
