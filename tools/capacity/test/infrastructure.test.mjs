import assert from "node:assert/strict";
import test from "node:test";
import { readInfrastructureTemplate, reviewPlan, validateInfrastructureTemplate } from "../infrastructure.mjs";

test("isolated capacity template passes its offline private-lab review", () => {
  const report = validateInfrastructureTemplate(readInfrastructureTemplate());
  assert.deepEqual(report, { kind: "authority-capacity-infrastructure-validation-v1", verdict: "pass", failures: [] });
  const plan = reviewPlan(readInfrastructureTemplate());
  assert.equal(plan.verdict, "not-run");
  assert.ok(plan.cost_bearing_resources.includes("one c7i.xlarge candidate instance"));
  assert.ok(plan.exclusions.some((entry) => entry.includes("no AWS call")));
});

test("validator rejects a public path, a latest-like AMI parameter, and weaker state storage", () => {
  const publicIp = structuredClone(readInfrastructureTemplate());
  publicIp.Resources.CapacityCandidate.Properties.NetworkInterfaces[0].AssociatePublicIpAddress = true;
  assert.match(validateInfrastructureTemplate(publicIp).failures.join("\n"), /public IP/);
  const latestAmi = structuredClone(readInfrastructureTemplate());
  latestAmi.Parameters.Ubuntu2404X8664AmiId.AllowedPattern = ".*";
  assert.match(validateInfrastructureTemplate(latestAmi).failures.join("\n"), /aliases/);
  const weakVolume = structuredClone(readInfrastructureTemplate());
  weakVolume.Resources.CapacityLabStateVolume.Properties.Iops = 1000;
  assert.match(validateInfrastructureTemplate(weakVolume).failures.join("\n"), /3000 IOPS/);
});

test("validator rejects a guessed account ID and an internet gateway", () => {
  const accountId = structuredClone(readInfrastructureTemplate());
  accountId.Outputs.Guessed = { Value: "123456789012" };
  assert.match(validateInfrastructureTemplate(accountId).failures.join("\n"), /account IDs/);
  const gateway = structuredClone(readInfrastructureTemplate());
  gateway.Resources.NotAllowed = { Type: "AWS::EC2::InternetGateway", Properties: {} };
  assert.match(validateInfrastructureTemplate(gateway).failures.join("\n"), /public or transit/);
});
