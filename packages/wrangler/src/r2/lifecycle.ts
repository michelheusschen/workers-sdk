import { inputPrompt } from "@cloudflare/cli/interactive";
import { readConfig } from "../config";
import { confirm } from "../dialogs";
import { UserError } from "../errors";
import { logger } from "../logger";
import { validate } from "../pages/validate";
import { readFileSync } from "../parse";
import { printWranglerBanner } from "../update-check";
import { requireAuth } from "../user";
import formatLabelledValues from "../utils/render-labelled-values";
import {
	formatActionDescription,
	getLifecycleRules,
	isValidDate,
	putLifecycleRules,
	tableFromLifecycleRulesResponse,
} from "./helpers";
import type {
	CommonYargsArgv,
	StrictYargsOptionsToInterface,
} from "../yargs-types";
import type { LifecycleCondition, LifecycleRule } from "./helpers";

export function ListOptions(yargs: CommonYargsArgv) {
	return yargs
		.positional("bucket", {
			describe: "The name of the R2 bucket to list lifecycle rules for",
			type: "string",
			demandOption: true,
		})
		.option("jurisdiction", {
			describe: "The jurisdiction where the bucket exists",
			alias: "J",
			requiresArg: true,
			type: "string",
		});
}

export async function ListHandler(
	args: StrictYargsOptionsToInterface<typeof ListOptions>
) {
	await printWranglerBanner();
	const config = readConfig(args.config, args);
	const accountId = await requireAuth(config);

	const { bucket, jurisdiction } = args;

	logger.log(`Listing lifecycle rules for bucket '${bucket}'...`);

	const lifecycleRules = await getLifecycleRules(
		accountId,
		bucket,
		jurisdiction
	);

	if (lifecycleRules.length === 0) {
		logger.log(`There are no lifecycle rules for bucket '${bucket}'.`);
	} else {
		const tableOutput = tableFromLifecycleRulesResponse(lifecycleRules);
		logger.log(tableOutput.map((x) => formatLabelledValues(x)).join("\n\n"));
	}
}

export function AddOptions(yargs: CommonYargsArgv) {
	return yargs
		.positional("bucket", {
			describe: "The name of the R2 bucket to a lifecycle for",
			type: "string",
			demandOption: true,
		})
		.positional("id", {
			describe: "A unique identifier for the lifecycle rule",
			type: "string",
			requiresArg: true,
		})
		.option("jurisdiction", {
			describe: "The jurisdiction where the bucket exists",
			alias: "J",
			requiresArg: true,
			type: "string",
		});
}

export async function AddHandler(
	args: StrictYargsOptionsToInterface<typeof AddOptions>
) {
	await printWranglerBanner();
	const config = readConfig(args.config, args);
	const accountId = await requireAuth(config);

	const { bucket, id, jurisdiction } = args;

	const isInteractive = process.stdin.isTTY;
	if (!isInteractive) {
		throw new UserError(
			"This command requires user input and cannot be run non-interactively."
		);
	}

	const lifecycleRules = await getLifecycleRules(
		accountId,
		bucket,
		jurisdiction
	);

	const ruleId: string =
		id ??
		(await inputPrompt({
			type: "text",
			label: "id",
			question: "Enter a unique identifier for the lifecycle rule",
			validate: (value) => {
				if (typeof value !== "string") {
					return "unknown error";
				}
				if (value.length === 0) {
					return "This field cannot be empty";
				}
			},
		}));

	const newRule: LifecycleRule = {
		id: ruleId,
		enabled: true,
		conditions: {},
	};

	const prefix = await inputPrompt({
		type: "text",
		label: "prefix",
		question:
			"Enter a prefix for the lifecycle rule (leave empty for all prefixes)",
	});
	if (prefix) {
		newRule.conditions.prefix = prefix;
	}

	const actionChoices = [
		{ label: "Expire objects", value: "expire" },
		{
			label: "Transition to Infrequent Access storage class",
			value: "transition",
		},
		{ label: "Abort incomplete multipart uploads", value: "abort-multipart" },
	];

	const selectedActions = await inputPrompt({
		type: "multiselect",
		label: "actions",
		question: "Select the actions to apply",
		options: actionChoices,
		validate: (values) => {
			if (!Array.isArray(values)) {
				return "unknown error";
			}
			if (values.length === 0) {
				return "Select atleast one action";
			}
		},
	});

	for (const action of selectedActions) {
		let conditionType: "Age" | "Date";
		let conditionValue: number | string;

		if (action === "abort-multipart") {
			const conditionInput = await inputPrompt({
				type: "text",
				label: "condition",
				question: `Enter the number of days after which to ${formatActionDescription(action)}`,
				validate: (value) => {
					if (isNaN(Number(value))) {
						return "Please enter a number of days";
					}
				},
			});

			conditionType = "Age";
			conditionValue = Number(conditionInput) * 86400; // Convert days to seconds

			newRule.abortMultipartUploadsTransition = {
				condition: {
					maxAge: conditionValue,
					type: conditionType,
				},
			};
		} else {
			const conditionInput = await inputPrompt({
				type: "text",
				label: "condition",
				question: `Enter the number of days or a date (YYYY-MM-DD) after which to ${formatActionDescription(action)}`,
				validate: (value) => {
					if (isNaN(Number(value)) && !isValidDate(String(value))) {
						return "Please enter a number of days or a valid date in the YYYY-MM-DD format";
					}
				},
			});

			if (!isNaN(Number(conditionInput))) {
				conditionType = "Age";
				conditionValue = Number(conditionInput) * 86400; // Convert days to seconds
			} else if (isValidDate(conditionInput)) {
				conditionType = "Date";
				const date = new Date(`${conditionInput}T00:00:00.000Z`);
				conditionValue = date.toISOString();
			} else {
				throw new UserError("Invalid condition input.");
			}

			if (action === "expire") {
				newRule.deleteObjectsTransition = {
					condition: {
						[conditionType === "Age" ? "maxAge" : "date"]: conditionValue,
						type: conditionType,
					},
				};
			} else if (action === "transition") {
				newRule.storageClassTransitions = [
					{
						condition: {
							[conditionType === "Age" ? "maxAge" : "date"]: conditionValue,
							type: conditionType,
						},
						storageClass: "InfrequentAccess",
					},
				];
			}
		}
	}

	lifecycleRules.push(newRule);
	logger.log(`Adding lifecycle rule '${ruleId}' to bucket '${bucket}'...`);
	await putLifecycleRules(accountId, bucket, lifecycleRules, jurisdiction);
	logger.log(`✨ Added lifecycle rule '${ruleId}' to bucket '${bucket}'.`);
}

export function RemoveOptions(yargs: CommonYargsArgv) {
	return yargs
		.positional("bucket", {
			describe: "The name of the R2 bucket to remove a lifecycle rule from",
			type: "string",
			demandOption: true,
		})
		.option("id", {
			describe: "The unique identifier of the lifecycle rule to remove",
			type: "string",
			demandOption: true,
			requiresArg: true,
		})
		.option("jurisdiction", {
			describe: "The jurisdiction where the bucket exists",
			alias: "J",
			requiresArg: true,
			type: "string",
		});
}

export async function RemoveHandler(
	args: StrictYargsOptionsToInterface<typeof RemoveOptions>
) {
	await printWranglerBanner();
	const config = readConfig(args.config, args);
	const accountId = await requireAuth(config);

	const { bucket, id, jurisdiction } = args;

	const lifecycleRules = await getLifecycleRules(
		accountId,
		bucket,
		jurisdiction
	);

	const index = lifecycleRules.findIndex((rule) => rule.id === id);

	if (index === -1) {
		throw new UserError(
			`Lifecycle rule with ID '${id}' not found in policy for '${bucket}'.`
		);
	}

	lifecycleRules.splice(index, 1);

	logger.log(`Removing lifecycle rule '${id}' from bucket '${bucket}'...`);
	await putLifecycleRules(accountId, bucket, lifecycleRules, jurisdiction);
	logger.log(`Lifcycle rule '${id}' removed from bucket '${bucket}'.`);
}

export function SetOptions(yargs: CommonYargsArgv) {
	return yargs
		.positional("bucket", {
			describe: "The name of the R2 bucket to set lifecycle policy for",
			type: "string",
			demandOption: true,
		})
		.option("file", {
			describe: "Path to the JSON file containing lifecycle policy",
			type: "string",
			demandOption: true,
			requiresArg: true,
		})
		.option("jurisdiction", {
			describe: "The jurisdiction where the bucket exists",
			alias: "J",
			requiresArg: true,
			type: "string",
		})
		.option("force", {
			describe: "Skip confirmation",
			type: "boolean",
			alias: "y",
			default: false,
		});
}

export async function SetHandler(
	args: StrictYargsOptionsToInterface<typeof SetOptions>
) {
	await printWranglerBanner();
	const config = readConfig(args.config, args);
	const accountId = await requireAuth(config);

	const { bucket, file, jurisdiction, force } = args;
	let lifecyclePolicy: { rules: LifecycleRule[] };
	try {
		lifecyclePolicy = JSON.parse(readFileSync(file));
	} catch (e) {
		if (e instanceof Error) {
			throw new UserError(
				`Failed to read or parse the lifecycle policy config file: '${e.message}'`
			);
		} else {
			throw e;
		}
	}

	if (!lifecyclePolicy.rules || !Array.isArray(lifecyclePolicy.rules)) {
		throw new UserError(
			"The lifecycle policy config file must contain a 'rules' array."
		);
	}

	if (!force) {
		const confirmedRemoval = await confirm(
			`Are you sure you want to overwrite all existing lifecycle rules for bucket '${bucket}'? `
		);
		if (!confirmedRemoval) {
			logger.log("Set cancelled.");
			return;
		}
	}
	logger.log(
		`Setting lifecycle policy (${lifecyclePolicy.rules.length} rules) for bucket '${bucket}'...`
	);
	await putLifecycleRules(
		accountId,
		bucket,
		lifecyclePolicy.rules,
		jurisdiction
	);
	logger.log(`✨ Set lifecycle policy for bucket '${bucket}'.`);
}
