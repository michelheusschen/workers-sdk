import {
	cancel,
	crash,
	endSection,
	log,
	logRaw,
	shapes,
	startSection,
	success,
	updateStatus,
} from "@cloudflare/cli";
import { processArgument } from "@cloudflare/cli/args";
import { bold, brandColor, dim, red } from "@cloudflare/cli/colors";
import TOML, { JsonMap } from "@iarna/toml";
import Diff from "diff";
import { Config } from "../config";
import {
	CommonYargsArgvJSON,
	StrictYargsOptionsToInterfaceJSON,
} from "../yargs-types";
import {
	ApiError,
	Application,
	ApplicationID,
	ApplicationName,
	ApplicationsService,
	CreateApplicationRequest,
	DeploymentMutationError,
	ModifyApplicationRequestBody,
	SchedulingPolicy,
} from "./client";
import { promiseSpinner } from "./common";
import { wrap } from "./helpers/wrap";

export function applyCommandOptionalYargs(yargs: CommonYargsArgvJSON) {
	return yargs;
}

function applicationToCreateApplication(
	application: Application
): CreateApplicationRequest {
	return {
		configuration: application.configuration,
		constraints: application.constraints,
		name: application.name,
		scheduling_policy: application.scheduling_policy,
		affinities: application.affinities,
		instances: application.instances,
		jobs: application.jobs ? true : undefined,
	};
}

function isNumber(c: string | number) {
	if (typeof c === "number") return true;
	const code = c.charCodeAt(0);
	const zero = "0".charCodeAt(0);
	const nine = "9".charCodeAt(0);
	return code >= zero && code <= nine;
}

function printLine(el: string, startWith = "", printFunc = log) {
	let line = startWith;
	let lastAdded = 0;
	const addToLine = (i: number, color = (s: string) => s) => {
		line += color(el.slice(lastAdded, i));
		lastAdded = i;
	};

	const state = {
		render: "left" as "quotes" | "number" | "left" | "right" | "section",
	};
	for (let i = 0; i < el.length; i++) {
		const current = el[i];
		const peek = i + 1 < el.length ? el[i + 1] : null;
		const prev = i === 0 ? null : el[i - 1];

		switch (state.render) {
			case "left":
				if (current === "=") {
					state.render = "right";
				}

				break;
			case "right":
				if (current === '"') {
					addToLine(i);
					state.render = "quotes";
					break;
				}

				if (isNumber(current)) {
					addToLine(i);
					state.render = "number";
					break;
				}

				if (current === "[" && peek === "[") {
					state.render = "section";
				}
			case "quotes":
				if (current === '"') {
					addToLine(i + 1, brandColor);
					state.render = "right";
				}

				break;
			case "number":
				if (!isNumber(el)) {
					addToLine(i, red);
					state.render = "right";
				}

				break;
			case "section":
				if (current === "]" && prev === "]") {
					addToLine(i + 1);
					state.render = "right";
				}
		}
	}

	switch (state.render) {
		case "left":
			addToLine(el.length);
			break;
		case "right":
			addToLine(el.length);
			break;
		case "quotes":
			addToLine(el.length, brandColor);
			break;
		case "number":
			addToLine(el.length, red);
			break;
		case "section":
			// might be unreachable
			addToLine(el.length, bold);
			break;
	}

	printFunc(line);
}

// TODO: has to do it recursively. But we can get away without doing that.
function stripUndefined<T = Record<string, unknown>>(r: T): T {
	for (const k in r) {
		if (r[k] === undefined) {
			delete r[k];
		}
	}

	return r;
}

const order = (unordered: Record<string | number, unknown>) => {
	if (Array.isArray(unordered)) {
		return unordered;
	}

	return Object.keys(unordered)
		.sort()
		.reduce(
			(obj, key) => {
				obj[key] = unordered[key];
				return obj;
			},
			{} as Record<string, unknown>
		);
};

function sortObjectDeeply<T = Record<string | number, unknown>>(
	object: Record<string | number, unknown> | Record<string | number, unknown>[]
): T {
	if (typeof object !== "object") {
		return object;
	}

	if (Array.isArray(object)) {
		return object.map((obj) => sortObjectDeeply(obj)) as T;
	}

	const objectCopy: Record<string | number, unknown> = { ...object };
	for (let [key, value] of Object.entries(object)) {
		if (typeof value === "object") {
			if (value === null) continue;
			objectCopy[key] = sortObjectDeeply(
				value as Record<string, unknown>
			) as unknown;
		}
	}

	return order(objectCopy) as T;
}

export async function applyCommand(
	args: StrictYargsOptionsToInterfaceJSON<typeof applyCommandOptionalYargs>,
	config: Config
) {
	startSection(
		"Deploy a container application",
		"deploy all the changes of your application"
	);

	if (config.container_app.length === 0) {
		endSection(
			"You don't have any container applications defined in your wrangler.toml",
			"You can set the following configuration in your wrangler.toml"
		);
		const configuration: CreateApplicationRequest = {
			configuration: {
				image: "docker.io/cloudflare/containers:getting-started",
			},
			instances: 2,
			scheduling_policy: SchedulingPolicy.REGIONAL,
			name: config.name ?? "my-containers-application",
		};
		const endConfig: JsonMap =
			args.env !== undefined
				? {
						env: { [args.env]: { container_app: [configuration] } },
					}
				: { container_app: [configuration] };
		TOML.stringify(endConfig)
			.split("\n")
			.map((el) => el.trim())
			.forEach((el) => {
				printLine(el, "  ", logRaw);
			});
		return;
	}

	const applications = await promiseSpinner(
		ApplicationsService.listApplications(),
		{ json: args.json, message: "loading applications" }
	);
	const applicationByNames: Record<ApplicationName, Application> = {};
	// TODO: this is not correct right now as there can be multiple applications
	// with the same name.
	for (const application of applications) {
		applicationByNames[application.name] = application;
	}

	const actions: (
		| { action: "create"; application: CreateApplicationRequest }
		| {
				action: "modify";
				application: ModifyApplicationRequestBody;
				id: ApplicationID;
				name: ApplicationName;
		  }
	)[] = [];

	log(dim("Container application changes\n"));

	for (const appConfig of config.container_app) {
		const application = applicationByNames[appConfig.name];
		if (application !== undefined && application !== null) {
			const prevApp = sortObjectDeeply<CreateApplicationRequest>(
				stripUndefined(applicationToCreateApplication(application))
			);

			const prev = TOML.stringify({ container_app: prevApp });
			const now = TOML.stringify({
				container_app: sortObjectDeeply<CreateApplicationRequest>(appConfig),
			});
			const lines = Diff.diffLines(prev, now);
			let printedOneLine = false;
			const changes = lines.find((l) => l.added || l.removed) !== undefined;
			if (!changes) {
				updateStatus(`no changes ${brandColor(application.name)}`);
				continue;
			}

			updateStatus(`${brandColor.underline("edited")} ${application.name}`);
			for (const line of lines) {
				const lineValues = line.value
					.split("\n")
					.map((e) => e.trim())
					.filter((e) => e !== "");
				for (const l of lineValues) {
					if (l.startsWith("[") && printedOneLine) {
						printLine("");
					}

					printedOneLine = true;
					if (line.added) {
						printLine(l, brandColor("+ "));
					} else if (line.removed) {
						printLine(l, red("- "));
					} else {
						printLine(l, "  ");
					}
				}
			}

			actions.push({
				action: "modify",
				application: appConfig,
				id: application.id,
				name: application.name,
			});

			printLine("");
			continue;
		}

		updateStatus(
			bold.underline(brandColor("new")) + ` ${brandColor(appConfig.name)}`
		);

		const s = TOML.stringify({ container_app: [appConfig] });

		s.split("\n")
			.map((line) => line.trim())
			.forEach((el) => {
				printLine(el);
			});
		actions.push({
			action: "create",
			application: appConfig,
		});
	}

	if (actions.length == 0) {
		endSection("No changes to be made");
		return;
	}

	const yes = await processArgument<boolean>(
		{ confirm: args.json ? true : undefined },
		"confirm",
		{
			type: "confirm",
			question: "Do you want to apply these changes?",
			label: "",
		}
	);
	if (!yes) {
		cancel("Not applying changes");
		return;
	}

	for (const action of actions) {
		if (action.action === "create") {
			const [_result, err] = await wrap(
				promiseSpinner(
					ApplicationsService.createApplication(action.application),
					{ json: args.json, message: `creating ${action.application.name}` }
				)
			);
			if (err !== null) {
				if (!(err instanceof ApiError)) {
					crash(`Unexpected error creating application: ${err.message}`);
				}

				if (err.status === 400) {
					let message = "";
					if (
						err.body.error === DeploymentMutationError.VALIDATE_INPUT &&
						err.body.details !== undefined
					) {
						for (const key in err.body.details) {
							message += `  ${brandColor(key)} ${err.body.details[key]}\n`;
						}
					} else {
						message += `  ${err.body.error}`;
					}

					crash(
						`Error creating application due to a misconfiguration\n${message}`
					);
				}

				crash(
					`Error creating application due to an internal error (request id: ${err.body.request_id}): ${err.body.error}`
				);
			}

			success(`Created application ${brandColor(action.application.name)}`, {
				shape: shapes.bar,
			});
			printLine("");
			continue;
		} else if (action.action === "modify") {
			const [_result, err] = await wrap(
				promiseSpinner(
					ApplicationsService.modifyApplication(action.id, action.application),
					{
						json: args.json,
						message: `modifying application ${action.name}`,
					}
				)
			);
			if (err !== null) {
				if (!(err instanceof ApiError)) {
					crash(
						`Unexpected error modifying application ${action.name}: ${err.message}`
					);
				}

				if (err.status === 400) {
					let message = "";
					if (
						err.body.error === DeploymentMutationError.VALIDATE_INPUT &&
						err.body.details !== undefined
					) {
						for (const key in err.body.details) {
							message += `  ${brandColor(key)} ${err.body.details[key]}\n`;
						}
					} else {
						message += `  ${err.body.error}`;
					}

					crash(
						`Error modifying application ${action.name} due to a misconfiguration\n${message}`
					);
				}

				crash(
					`Error modifying application ${action.name} due to an internal error (request id: ${err.body.request_id}): ${err.body.error}`
				);
			}

			success(`Modified application ${brandColor(action.name)}`, {
				shape: shapes.bar,
			});
			printLine("");
			continue;
		}
	}

	endSection("Applied changes");
}
