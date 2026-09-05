# Capacity lab infrastructure review

`infrastructure-v1.template.json` is an offline CloudFormation proposal for a
separate V1 capacity lab. It does not reuse staging resources or accept a
latest AMI selector. Review must supply the exact Ubuntu 24.04 x86_64 AMI,
private VPC and subnet CIDRs, one Availability Zone, regional S3 prefix list,
and immutable bootstrap artifact bucket, key, version, digest and source
commit.

Run the offline checks before a human change-set review:

```sh
node tools/capacity/infrastructure.mjs validate
node tools/capacity/infrastructure.mjs plan
```

The plan deliberately reports `not-run`. It creates no stack and cannot become
a capacity result. The template is foundation-only: it records the immutable
bootstrap artifact and does not install it or launch a candidate process. The
template has one private c7i.xlarge candidate, a
separate same-AZ driver/fixture host, an encrypted retained 100 GiB gp3 state
volume, private SSM endpoints and a private S3 gateway endpoint. It has no
public IP, SSH ingress, internet gateway or NAT gateway.

The candidate may call the private driver fixture over narrowly scoped TLS, and
the driver may call the candidate's verifier-observer endpoint over separately
scoped TLS. The private driver never reaches FreeTSA or another public
timestamp service. A verifier-owned digest-only external anchor relay receives
only registry hashes and returns the signed timestamp receipt; its reviewed
protocol digest is a required template input.

The human operator remains bound to
`docs/operations/PB-OPERATIONS-001-authority-operator-lane.md`: use only the
installed bounded wrapper through the approved human Session Manager lane.
