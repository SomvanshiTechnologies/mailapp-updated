#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { loadConfig } from "../config.js";
import { buildEc2Stacks, buildStacks } from "../lib/stacks.js";

const app = new App();
const config = loadConfig(app);
if (config.deployTarget === "ec2") buildEc2Stacks(app, config);
else buildStacks(app, config);
Tags.of(app).add("Project", "mailapp");
Tags.of(app).add("Environment", config.envName);
app.synth();
