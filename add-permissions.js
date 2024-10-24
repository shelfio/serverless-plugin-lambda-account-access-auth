"use strict";

const STRING_OR_NUMBER_SCHEMA = {
  anyOf: [{ type: "string" }, { type: "integer" }],
};

const PRINCIPALS_SCHEMA = {
  anyOf: [
    {
      type: "array",
      items: STRING_OR_NUMBER_SCHEMA,
    },
    STRING_OR_NUMBER_SCHEMA,
    { type: "string" },
  ],
};

const STRING_OR_STRING_ARRAY_SCHEMA = {
  anyOf: [
    {
      type: "array",
      items: {
        type: "string",
      },
    },
    {
      type: "string",
    },
  ],
};

const ROLE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    principals: PRINCIPALS_SCHEMA,
    allowTagSession: { type: "boolean" },
    maxSessionDuration: {
      type: "integer",
      minimum: 3600,
      maximum: 43200,
    },
  },
  required: ["name", "principals"],
  additionalProperties: false,
};

const ACCESS_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "object",
      patternProperties: {
        ".+": {
          type: "object",
          properties: {
            role: {
              anyOf: [
                {
                  type: "array",
                  items: ROLE_SCHEMA,
                },
                ROLE_SCHEMA,
              ],
            },
            policy: {
              type: "object",
              properties: {
                principals: PRINCIPALS_SCHEMA,
                sourceArns: {
                  type: "array",
                  items: { type: "string" },
                },
                consumerService: {
                  type: "string",
                },
                fns: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["principals"],
            },
          },
          minProperties: 1,
          additionalProperties: false,
        },
      },
      minProperties: 1,
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

module.exports = class AwsAddLambdaAccountPermissions {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider("aws");
    this.hooks = {
      "package:createDeploymentArtifacts": () => this.beforeDeploy(),
    };

    if (serverless.configSchemaHandler) {
      if (serverless.configSchemaHandler.defineFunctionProperties) {
        serverless.configSchemaHandler.defineFunctionProperties("aws", {
          properties: {
            allowAccess: STRING_OR_STRING_ARRAY_SCHEMA,
          },
        });
      }

      if (serverless.configSchemaHandler.defineProvider) {
        serverless.configSchemaHandler.defineProvider("aws", {
          provider: {
            properties: {
              access: ACCESS_SCHEMA,
            },
          },
        });
      }
    }
  }

  addPermissions(accessConfig) {
    const { service } = this.serverless;
    const resources = (service.resources = service.resources || {});
    if (!resources.Resources) {
      resources.Resources = {};
    }

    Object.keys(accessConfig).reduce((dependsOnList, groupName) => {
      const { functions, policy, role } = accessConfig[groupName];

      if (functions.length !== 0) {
        if (policy) {
          [].concat(policy.principals).forEach((principal) => {
            const { principal: normalizedPrincipal, principalName } =
              this.normalizePrincipal(principal);

            functions.forEach((functionLogicalId) => {
              const resourceName = `${functionLogicalId}PermitInvokeFrom${principalName}`;

              if (!resources.Resources[resourceName]) {
                const resource = {
                  Type: "AWS::Lambda::Permission",
                  Properties: {
                    Action: "lambda:InvokeFunction",
                    FunctionName: {
                      "Fn::GetAtt": [functionLogicalId, "Arn"],
                    },
                    Principal: normalizedPrincipal,
                  },
                };

                if (policy.consumerService) {
                  // Allow invocation from the consumer's Lambda execution role
                  if (!policy.fns || policy.fns.length === 0) {
                    throw new Error(
                      "fns array is required and cannot be empty when consumerService is specified"
                    );
                  }
                  const region = this.serverless.service.provider.region;
                  const stage =
                    this.options.stage ||
                    this.serverless.service.provider.stage;

                  // Create separate permissions for each function
                  policy.fns.forEach((fn) => {
                    const fnResourceName = `Invoke${principalName}${fn}`;
                    const fnResource = {
                      Type: "AWS::Lambda::Permission",
                      Properties: {
                        Action: "lambda:InvokeFunction",
                        FunctionName: {
                          "Fn::GetAtt": [functionLogicalId, "Arn"],
                        },
                        Principal: `arn:aws:iam::${normalizedPrincipal}:role/${policy.consumerService}-${stage}-${fn}-${region}-lambdaRole`
                      },
                    };
                    resources.Resources[fnResourceName] = fnResource;
                  });

                  return; // Skip creating the original resource
                } else if (policy.sourceArns && policy.sourceArns.length > 0) {
                  resource.Properties.SourceArn = policy.sourceArns[0];
                }

                const dependsOn = dependsOnList[functionLogicalId];
                if (dependsOn) {
                  resource.DependsOn = dependsOn;
                }

                resources.Resources[resourceName] = resource;
                dependsOnList[functionLogicalId] = resourceName;
              }
            });
          });
        }

        if (role) {
          []
            .concat(role)
            .forEach(
              ({
                allowTagSession = false,
                maxSessionDuration = 3600,
                name,
                principals,
              }) => {
                const resourceName = `LambdaAccessRole${this.normalizeName(
                  name
                )}`;
                if (resources.Resources[resourceName]) {
                  throw new Error(`Roles must have unique names [${name}]`);
                }

                let stsAction = "sts:AssumeRole";
                if (allowTagSession) {
                  stsAction = ["sts:AssumeRole", "sts:TagSession"];
                }

                if (principals.length !== 0) {
                  const resource = {
                    Type: "AWS::IAM::Role",
                    Properties: {
                      RoleName: name,
                      Policies: [
                        {
                          PolicyName: name,
                          PolicyDocument: {
                            Version: "2012-10-17",
                            Statement: [
                              {
                                Effect: "Allow",
                                Action: "lambda:InvokeFunction",
                                Resource: functions.map(
                                  (functionLogicalId) => ({
                                    "Fn::GetAtt": [functionLogicalId, "Arn"],
                                  })
                                ),
                              },
                            ],
                          },
                        },
                      ],
                      AssumeRolePolicyDocument: {
                        Version: "2012-10-17",
                        Statement: [
                          {
                            Effect: "Allow",
                            Action: stsAction,
                            Principal: {
                              AWS: []
                                .concat(principals)
                                .map(
                                  (principal) =>
                                    this.normalizePrincipal(principal).principal
                                ),
                            },
                          },
                        ],
                      },
                      MaxSessionDuration: maxSessionDuration,
                    },
                  };

                  resources.Resources[resourceName] = resource;
                }
              }
            );
        }
      } else {
        this.log(`WARNING: Group "${groupName}" is not used`);
      }

      return dependsOnList;
    }, {});
  }

  beforeDeploy() {
    const { service } = this.serverless;
    const { functions, provider: { access } = {} } = service;
    if (typeof functions !== "object" || !access) {
      return;
    }

    const { groups } = access;
    const accessConfig = this.compileAccessConfig(groups, functions);

    this.addPermissions(accessConfig);
  }

  compileAccessConfig(groups, functions) {
    const accessConfig = Object.keys(groups).reduce((acc, groupName) => {
      const { policy, role } = groups[groupName];
      acc[groupName] = {
        functions: [],
        policy,
        role,
      };

      return acc;
    }, {});

    return Object.keys(functions).reduce((acc, functionName) => {
      const { allowAccess } = functions[functionName];

      if (allowAccess) {
        const functionLogicalId =
          this.provider.naming.getLambdaLogicalId(functionName);
        [].concat(allowAccess).forEach((groupName) => {
          const groupConf = acc[groupName];
          if (!groupConf) {
            throw new Error(
              `Function "${functionName}" references an access group "${groupName}" that does not exist`
            );
          }

          groupConf.functions.push(functionLogicalId);
        });
      }

      return acc;
    }, accessConfig);
  }

  log(message) {
    this.serverless.cli.log(
      `[serverless-plugin-lambda-account-access]: ${message}`
    );
  }

  normalizeName(name) {
    return name.replace(/\b\w/g, (l) => l.toUpperCase()).replace(/[_\W]+/g, "");
  }

  normalizePrincipal(principal) {
    let principalString;
    const fnName =
      principal instanceof Object
        ? Object.keys(principal).find((k) => k.indexOf("Fn::") >= 0)
        : undefined;
    if (fnName) {
      principalString = principal[fnName].toString();
    } else {
      principal = principal.toString();
      principalString = principal;
    }

    // Extract account ID from assumed role ARN if present
    if (principalString.includes(":assumed-role/")) {
      const accountId = principalString.split(":")[4];
      return {
        principal: accountId,
        principalName: this.normalizeName(accountId),
      };
    }

    return {
      principal,
      principalName: this.normalizeName(principalString),
    };
  }
};
