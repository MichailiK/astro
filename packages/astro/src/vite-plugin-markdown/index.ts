import {
	createMarkdownProcessor,
	InvalidAstroDataError,
	type MarkdownProcessor,
} from '@astrojs/markdown-remark';
import matter from 'gray-matter';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { normalizePath } from 'vite';
import type { AstroSettings } from '../@types/astro.js';
import { AstroError, AstroErrorData, MarkdownError } from '../core/errors/index.js';
import type { Logger } from '../core/logger/core.js';
import { isMarkdownFile } from '../core/util.js';
import { shorthash } from '../runtime/server/shorthash.js';
import type { PluginMetadata } from '../vite-plugin-astro/types.js';
import { escapeViteEnvReferences, getFileInfo } from '../vite-plugin-utils/index.js';

interface AstroPluginOptions {
	settings: AstroSettings;
	logger: Logger;
}

function safeMatter(source: string, id: string) {
	try {
		return matter(source);
	} catch (err: any) {
		const markdownError = new MarkdownError({
			name: 'MarkdownError',
			message: err.message,
			stack: err.stack,
			location: {
				file: id,
			},
		});

		if (err.name === 'YAMLException') {
			markdownError.setLocation({
				file: id,
				line: err.mark.line,
				column: err.mark.column,
			});

			markdownError.setMessage(err.reason);
		}

		throw markdownError;
	}
}

const astroServerRuntimeModulePath = normalizePath(
	fileURLToPath(new URL('../runtime/server/index.js', import.meta.url))
);

const astroErrorModulePath = normalizePath(
	fileURLToPath(new URL('../core/errors/index.js', import.meta.url))
);

export default function markdown({ settings, logger }: AstroPluginOptions): Plugin {
	let processor: MarkdownProcessor;

	return {
		enforce: 'pre',
		name: 'astro:markdown',
		async buildStart() {
			processor = await createMarkdownProcessor(settings.config.markdown);
		},
		// Why not the "transform" hook instead of "load" + readFile?
		// A: Vite transforms all "import.meta.env" references to their values before
		// passing to the transform hook. This lets us get the truly raw value
		// to escape "import.meta.env" ourselves.
		async load(id) {
			if (isMarkdownFile(id)) {
				const { fileId, fileUrl } = getFileInfo(id, settings.config);
				const rawFile = await fs.promises.readFile(fileId, 'utf-8');
				const raw = safeMatter(rawFile, id);

				const renderResult = await processor
					.render(raw.content, {
						fileURL: new URL(`file://${fileId}`),
						frontmatter: raw.data,
					})
					.catch((err) => {
						// Improve error message for invalid astro data
						if (err instanceof InvalidAstroDataError) {
							throw new AstroError(AstroErrorData.InvalidFrontmatterInjectionError);
						}
						throw err;
					});

				let html = renderResult.code;
				const { headings, imagePaths: rawImagePaths, frontmatter } = renderResult.metadata;

				// Resolve all the extracted images from the content
				const imagePaths: { raw: string; resolved: string; safeName: string }[] = [];
				for (const imagePath of rawImagePaths.values()) {
					imagePaths.push({
						raw: imagePath,
						resolved:
							(await this.resolve(imagePath, id))?.id ?? path.join(path.dirname(id), imagePath),
						safeName: shorthash(imagePath),
					});
				}

				const { layout } = frontmatter;

				if (frontmatter.setup) {
					logger.warn(
						'markdown',
						`[${id}] Astro now supports MDX! Support for components in ".md" (or alternative extensions like ".markdown") files using the "setup" frontmatter is no longer enabled by default. Migrate this file to MDX.`
					);
				}

				const code = escapeViteEnvReferences(`
				import { unescapeHTML, spreadAttributes, createComponent, render, renderComponent, maybeRenderHead } from ${JSON.stringify(
					astroServerRuntimeModulePath
				)};
				import { AstroError, AstroErrorData } from ${JSON.stringify(astroErrorModulePath)};

				${layout ? `import Layout from ${JSON.stringify(layout)};` : ''}
				import { getImage } from "astro:assets";
				${imagePaths
					.map((entry) => `import Astro__${entry.safeName} from ${JSON.stringify(entry.raw)};`)
					.join('\n')}

				const images = async function() {
					return {
						${imagePaths
							.map((entry) => `"${entry.raw}": await getImage({src: Astro__${entry.safeName}})`)
							.join(',\n')}
					}
				}

				async function updateImageReferences(html) {
					return images().then((images) => {
						return html.replaceAll(/__ASTRO_IMAGE_="([^"]+)"/gm, (full, imagePath) =>
							spreadAttributes({
								src: images[imagePath].src,
								...images[imagePath].attributes,
							})
						);
					});
				}

				const html = await updateImageReferences(${JSON.stringify(html)});

				export const frontmatter = ${JSON.stringify(frontmatter)};
				export const file = ${JSON.stringify(fileId)};
				export const url = ${JSON.stringify(fileUrl)};
				export function rawContent() {
					return ${JSON.stringify(raw.content)};
				}
				export function compiledContent() {
					return html;
				}
				export function getHeadings() {
					return ${JSON.stringify(headings)};
				}

				export const Content = createComponent((result, _props, slots) => {
					const { layout, ...content } = frontmatter;
					content.file = file;
					content.url = url;

					return ${
						layout
							? `render\`\${renderComponent(result, 'Layout', Layout, {
								file,
								url,
								content,
								frontmatter: content,
								headings: getHeadings(),
								rawContent,
								compiledContent,
								'server:root': true,
							}, {
								'default': () => render\`\${unescapeHTML(html)}\`
							})}\`;`
							: `render\`\${maybeRenderHead(result)}\${unescapeHTML(html)}\`;`
					}
				});
				export default Content;
				`);

				return {
					code,
					meta: {
						astro: {
							hydratedComponents: [],
							clientOnlyComponents: [],
							scripts: [],
							propagation: 'none',
							containsHead: false,
							pageOptions: {},
						} as PluginMetadata['astro'],
						vite: {
							lang: 'ts',
						},
					},
				};
			}
		},
	};
}
