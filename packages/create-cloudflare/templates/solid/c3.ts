import { logRaw, updateStatus } from "@cloudflare/cli";
import { brandColor, dim, blue } from "@cloudflare/cli/colors";
import { installPackages, runFrameworkGenerator } from "helpers/command";
import { compatDateFlag, usesTypescript, writeFile } from "helpers/files";
import { detectPackageManager } from "helpers/packages";
import { viteConfig } from "./templates";
import type { FrameworkConfig, C3Context } from "types";

const { npm } = detectPackageManager();

const generate = async (ctx: C3Context) => {
	// Run the create-solid command
	await runFrameworkGenerator(ctx, [ctx.project.name]);

	logRaw("");
};

const configure = async (ctx: C3Context) => {
	process.chdir(ctx.project.path);

	// Install the pages adapter
	const pkg = "solid-start-cloudflare-pages";
	await installPackages([pkg], {
		dev: true,
		startText: "Adding the Cloudflare Pages adapter",
		doneText: `${brandColor(`installed`)} ${dim(pkg)}`,
	});

	// modify the vite config
	const viteConfigPath = usesTypescript()
		? `./vite.config.ts`
		: `./vite.config.js`;
	writeFile(viteConfigPath, viteConfig);
	updateStatus(
		`Adding the Cloudflare Pages adapter to ${blue(viteConfigPath)}`
	);
};

const config: FrameworkConfig = {
	id: "solid",
	displayName: "Solid",
	platform: "pages",
	generate,
	configure,
	getPackageScripts: async () => ({
		"pages:dev": `wrangler pages dev ${await compatDateFlag()} --proxy 3000 -- ${npm} run dev`,
		"pages:deploy": `${npm} run build && wrangler pages deploy ./dist/public`,
	}),
};
export default config;