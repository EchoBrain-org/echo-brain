#!/usr/bin/env node

/** Offline structure checks and review-plan output for the capacity lab. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultTemplate = resolve(here, "infrastructure-v1.template.json");

function fail(message) { throw new Error(`capacity infrastructure: ${message}`); }
function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}
function resource(template, id, type) {
  const value = object(template.Resources?.[id], `Resources.${id}`);
  if (value.Type !== type) fail(`Resources.${id} must be ${type}`);
  return value;
}
function ref(value, name) { return JSON.stringify(value) === JSON.stringify({ Ref: name }); }
function getAtt(value, id, attribute) { return JSON.stringify(value) === JSON.stringify({ "Fn::GetAtt": [id, attribute] }); }
function includesJson(values, wanted) { return Array.isArray(values) && values.some((value) => JSON.stringify(value) === JSON.stringify(wanted)); }

export function readInfrastructureTemplate(path = defaultTemplate) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

export function validateInfrastructureTemplate(template) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  try {
    object(template, "template");
    check(template.AWSTemplateFormatVersion === "2010-09-09", "template format version must be 2010-09-09");
    for (const parameter of ["LabVpcCidr", "LabSubnetCidr", "LabAvailabilityZone", "Ubuntu2404X8664AmiId", "S3PrefixListId", "BootstrapArtifactBucket", "BootstrapArtifactKey", "BootstrapArtifactVersion", "BootstrapArtifactSha256", "BootstrapArtifactSourceCommit", "AnchorRelayProtocolDigest", "LabOperationId", "ExpiresAt"]) {
      check(template.Parameters?.[parameter] !== undefined, `missing required parameter ${parameter}`);
      check(template.Parameters?.[parameter]?.Default === undefined, `required parameter ${parameter} may not have a default`);
    }
    check(template.Parameters?.Ubuntu2404X8664AmiId?.Type === "AWS::EC2::Image::Id", "AMI must be an exact AMI ID parameter");
    check(template.Parameters?.Ubuntu2404X8664AmiId?.AllowedPattern === "^ami-[0-9a-f]{8,17}$", "AMI parameter must reject aliases and latest selectors");
    check(template.Rules?.RequireUsWest2?.Assertions?.[0]?.AssertDescription?.includes("us-west-2"), "template must pin the capacity profile to us-west-2");
    const vpc = resource(template, "CapacityLabVpc", "AWS::EC2::VPC");
    check(ref(vpc.Properties?.CidrBlock, "LabVpcCidr"), "capacity lab must create its own VPC from LabVpcCidr");
    check(Object.values(template.Resources).every((entry) => !["AWS::EC2::InternetGateway", "AWS::EC2::NatGateway", "AWS::EC2::EIP", "AWS::EC2::VPNGatewayAttachment"].includes(entry.Type)), "capacity lab may not create public or transit network resources");
    const subnet = resource(template, "CapacityLabSubnet", "AWS::EC2::Subnet");
    check(subnet.Properties?.MapPublicIpOnLaunch === false, "capacity lab subnet must not map public IPs");
    check(ref(subnet.Properties?.VpcId, "CapacityLabVpc"), "capacity lab subnet must belong to its own VPC");
    const routeTable = resource(template, "CapacityLabRouteTable", "AWS::EC2::RouteTable");
    check(ref(routeTable.Properties?.VpcId, "CapacityLabVpc"), "capacity lab route table must remain in its own VPC");
    check(!Object.values(template.Resources).some((entry) => entry.Type === "AWS::EC2::Route"), "capacity lab must have no internet or transit routes");
    const hosts = [resource(template, "CapacityCandidate", "AWS::EC2::Instance"), resource(template, "CapacityDriver", "AWS::EC2::Instance")];
    check(hosts[0].Properties?.InstanceType === "c7i.xlarge", "candidate must be c7i.xlarge");
    for (const [index, host] of hosts.entries()) {
      check(ref(host.Properties?.ImageId, "Ubuntu2404X8664AmiId"), `host ${index} must use the pinned AMI parameter`);
      const network = host.Properties?.NetworkInterfaces?.[0];
      check(network?.AssociatePublicIpAddress === false, `host ${index} may not have a public IP`);
      check(ref(network?.SubnetId, "CapacityLabSubnet"), `host ${index} must share the private lab subnet and Availability Zone`);
      check(host.Properties?.MetadataOptions?.HttpTokens === "required", `host ${index} must require IMDSv2`);
      check(host.Properties?.UserData !== undefined, `host ${index} must record its pinned bootstrap artifact metadata`);
    }
    const volume = resource(template, "CapacityLabStateVolume", "AWS::EC2::Volume");
    check(volume.DeletionPolicy === "Retain" && volume.UpdateReplacePolicy === "Retain", "candidate state volume must be retained");
    check(volume.Properties?.Encrypted === true && volume.Properties?.Size === 100 && volume.Properties?.VolumeType === "gp3" && volume.Properties?.Iops === 3000 && volume.Properties?.Throughput === 125, "candidate state volume must be encrypted 100 GiB gp3 at 3000 IOPS and 125 MiB/s");
    const attachment = resource(template, "CapacityCandidateStateAttachment", "AWS::EC2::VolumeAttachment");
    check(ref(attachment.Properties?.InstanceId, "CapacityCandidate") && ref(attachment.Properties?.VolumeId, "CapacityLabStateVolume"), "state volume must attach only to the candidate");
    const candidateGroup = resource(template, "CapacityCandidateSecurityGroup", "AWS::EC2::SecurityGroup");
    const driverGroup = resource(template, "CapacityDriverSecurityGroup", "AWS::EC2::SecurityGroup");
    check(Array.isArray(candidateGroup.Properties?.SecurityGroupIngress) && candidateGroup.Properties.SecurityGroupIngress.length === 0, "candidate security group must have no inline ingress");
    check(Array.isArray(driverGroup.Properties?.SecurityGroupIngress) && driverGroup.Properties.SecurityGroupIngress.length === 0, "driver security group must have no inline ingress");
    const endpointGroup = resource(template, "CapacityLabEndpointSecurityGroup", "AWS::EC2::SecurityGroup");
    check(Array.isArray(endpointGroup.Properties?.SecurityGroupIngress) && endpointGroup.Properties.SecurityGroupIngress.length === 0, "endpoint security group must not have inline ingress");
    const endpointIngress = resource(template, "CapacityLabEndpointIngress", "AWS::EC2::SecurityGroupIngress");
    check(endpointIngress.Properties?.FromPort === 443 && endpointIngress.Properties?.ToPort === 443 && getAtt(endpointIngress.Properties?.SourceSecurityGroupId, "CapacityCandidateSecurityGroup", "GroupId"), "private endpoint ingress must be HTTPS from candidate only");
    const endpointDriverIngress = resource(template, "CapacityLabEndpointIngressFromDriver", "AWS::EC2::SecurityGroupIngress");
    check(endpointDriverIngress.Properties?.FromPort === 443 && endpointDriverIngress.Properties?.ToPort === 443 && getAtt(endpointDriverIngress.Properties?.SourceSecurityGroupId, "CapacityDriverSecurityGroup", "GroupId"), "private endpoint ingress must allow the driver only");
    const providerEgress = resource(template, "CapacityCandidateProviderTlsEgress", "AWS::EC2::SecurityGroupEgress");
    const providerIngress = resource(template, "CapacityDriverProviderTlsIngress", "AWS::EC2::SecurityGroupIngress");
    check(getAtt(providerEgress.Properties?.DestinationSecurityGroupId, "CapacityDriverSecurityGroup", "GroupId") && getAtt(providerIngress.Properties?.SourceSecurityGroupId, "CapacityCandidateSecurityGroup", "GroupId") && providerEgress.Properties?.FromPort === 443 && providerIngress.Properties?.ToPort === 443, "candidate-to-driver provider TLS must be narrowly bound to HTTPS");
    const observerEgress = resource(template, "CapacityDriverVerifierObserverEgress", "AWS::EC2::SecurityGroupEgress");
    const observerIngress = resource(template, "CapacityCandidateVerifierObserverIngress", "AWS::EC2::SecurityGroupIngress");
    check(getAtt(observerEgress.Properties?.DestinationSecurityGroupId, "CapacityCandidateSecurityGroup", "GroupId") && getAtt(observerIngress.Properties?.SourceSecurityGroupId, "CapacityDriverSecurityGroup", "GroupId") && observerEgress.Properties?.FromPort === 443 && observerIngress.Properties?.ToPort === 443, "driver verifier-observer HTTPS must be narrowly bound to the candidate");
    for (const id of ["CapacityLabSsmEndpoint", "CapacityLabSsmMessagesEndpoint", "CapacityLabEc2MessagesEndpoint"]) {
      const endpoint = resource(template, id, "AWS::EC2::VPCEndpoint");
      check(endpoint.Properties?.VpcEndpointType === "Interface" && endpoint.Properties?.PrivateDnsEnabled === true, `${id} must be a private-DNS interface endpoint`);
      check(includesJson(endpoint.Properties?.SubnetIds, { Ref: "CapacityLabSubnet" }), `${id} must be inside the private lab subnet`);
    }
    const s3 = resource(template, "CapacityLabArtifactS3Endpoint", "AWS::EC2::VPCEndpoint");
    check(s3.Properties?.VpcEndpointType === "Gateway" && includesJson(s3.Properties?.RouteTableIds, { Ref: "CapacityLabRouteTable" }), "artifact S3 endpoint must be a private gateway endpoint on the lab route table");
    const role = resource(template, "CapacityLabHostRole", "AWS::IAM::Role");
    const artifactStatement = role.Properties?.Policies?.[0]?.PolicyDocument?.Statement?.[0];
    check(artifactStatement?.Action === "s3:GetObjectVersion" && ref(artifactStatement?.Condition?.StringEquals?.["s3:VersionId"], "BootstrapArtifactVersion"), "host role must read only the reviewed artifact version");
    check(!JSON.stringify(template).match(/\b(?:vpc|subnet|sg|vol)-[0-9a-f]{8,17}\b|\b\d{12}\b/), "template must not contain guessed resource IDs or account IDs");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return Object.freeze({ kind: "authority-capacity-infrastructure-validation-v1", verdict: failures.length === 0 ? "pass" : "fail", failures: Object.freeze(failures) });
}

export function reviewPlan(template) {
  const validation = validateInfrastructureTemplate(template);
  return Object.freeze({
    kind: "authority-capacity-infrastructure-plan-v1",
    verdict: validation.verdict === "pass" ? "not-run" : "fail",
    region: "us-west-2",
    required_review_inputs: ["LabVpcCidr", "LabSubnetCidr", "LabAvailabilityZone", "Ubuntu2404X8664AmiId", "S3PrefixListId", "BootstrapArtifactBucket", "BootstrapArtifactKey", "BootstrapArtifactVersion", "BootstrapArtifactSha256", "BootstrapArtifactSourceCommit", "AnchorRelayProtocolDigest", "LabOperationId", "ExpiresAt"],
    cost_bearing_resources: ["one c7i.xlarge candidate instance", "one t3.small or t3.medium driver instance", "one 100 GiB gp3 EBS state volume at 3000 IOPS and 125 MiB/s", "three interface VPC endpoints"],
    non_cost_or_control_resources: ["one isolated VPC", "one private subnet", "one route table with no internet route", "one S3 gateway endpoint", "two security groups", "one restricted host role and instance profile"],
    exclusions: ["no AWS call or provisioning was performed", "no staging or production resource is referenced", "no public IP, SSH rule, internet gateway, NAT gateway, or transit route is present", "the driver never calls a public timestamp authority; the reviewed digest-only external anchor relay is outside this VPC", "the template records but does not install or execute a bootstrap artifact, so it is not deploy-ready"],
    validation_failures: validation.failures,
  });
}

function main(argv) {
  const [command = "plan", path] = argv;
  if (!new Set(["validate", "plan"]).has(command) || argv.length > 2) fail("usage: infrastructure.mjs <validate|plan> [template.json]");
  const template = readInfrastructureTemplate(path ?? defaultTemplate);
  const result = command === "validate" ? validateInfrastructureTemplate(template) : reviewPlan(template);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.verdict === "fail") process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
