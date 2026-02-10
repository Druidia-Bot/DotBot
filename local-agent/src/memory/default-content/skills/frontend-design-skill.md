---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use when building web components, pages, applications, landing pages, dashboards, or any static web UI. Generates creative, polished code that avoids generic AI aesthetics.
tags: [frontend, design, ui, ux, react, svelte, tailwind, css, web]
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work — the key is intentionality, not intensity.

Then implement working code that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React or svelte-motion/svelte transitions for Svelte when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

## Anti-Patterns (NEVER do these)

- Generic AI-generated aesthetics: overused font families (Inter, Roboto, Arial, system fonts)
- Cliched color schemes (particularly purple gradients on white backgrounds)
- Predictable layouts and component patterns
- Cookie-cutter design that lacks context-specific character
- Converging on common choices (Space Grotesk, for example) across generations

## Framework Guidelines

### React Projects
- Use Tailwind CSS for styling, shadcn/ui for components, Lucide for icons
- Use Motion (formerly Framer Motion) for animations
- Prefer functional components with hooks
- Use CSS variables via Tailwind's theme extension for design tokens

### Svelte / SvelteKit Projects
- Use Tailwind CSS for styling, Bits UI or Skeleton UI for components, Lucide Svelte for icons
- Use Svelte's built-in transition and animate directives (`transition:fly`, `transition:fade`, `in:`, `out:`, `animate:flip`)
- Use svelte-motion or custom spring/tweened stores for complex animations
- Prefer `$state`, `$derived`, `$effect` runes (Svelte 5) for reactivity
- Use `{#snippet}` blocks for reusable template fragments
- Use SvelteKit's `+page.svelte`, `+layout.svelte`, and `+server.ts` conventions for routing
- Use `$app/stores` for page data and navigation state

### Vanilla HTML/CSS/JS
- Prioritize CSS-only solutions for animations (keyframes, transitions, scroll-driven animations)
- Use CSS custom properties for theming
- Prefer semantic HTML with progressive enhancement

## Implementation Notes

- Interpret creatively and make unexpected choices that feel genuinely designed for the context
- No design should be the same — vary between light and dark themes, different fonts, different aesthetics
- Match implementation complexity to the aesthetic vision: maximalist = elaborate code with extensive animations; minimalist = restraint, precision, careful spacing and typography
- Elegance comes from executing the vision well
- When the user doesn't specify a framework, ask or infer from the project context
