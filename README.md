[![CircleCI](https://circleci.com/gh/rschick/serverless-plugin-lambda-account-access/tree/master.svg?style=svg)](https://circleci.com/gh/rschick/serverless-plugin-lambda-account-access/tree/master)

# serverless-plugin-lambda-account-access

Add policies and/or roles to allow cross-account access to your functions.

## Usage Example

`serverless.yml`

```yaml
service: sample

plugins:
  - serverless-plugin-lambda-account-access

provider:
  access:
    groups:
      authorizergroup: # group to hold authorizer connection with different AWS account
        policy:
          principals: apigateway.amazonaws.com
          sourceArns:
            - arn:aws:execute-api:000000000000:*/authorizers/* # allow api gateway to invoke functions
      consumer: # group for cross-account lambda role access
        policy:
          principals: 000000000000 # consumer account ID
          consumerService: 'my-service' # service name used to construct the role ARN
          fns: # required when consumerService is specified
            - function1 # list of function names from the consumer service
            - function2
      api: # group has both role and policy access configured
        role:
          - name: sample-${self:custom.stage}-lambda-api-${self:custom.region}
            principals: # can be defined as a single value or an array
              - 111111111111 # principal as accountId
              - 'arn:aws:iam::222222222222:root' # principal as ARN
              - Fn::Import: cloudformation-output-arn # principal as CloudFormation Output Value ARN
            allowTagSession: True # can optionally be defined to include sts:TagSession in assume role policy
            maxSessionDuration: 3600 # can optionally be defined to control max duration of an assume role session
        policy:
          principals:
            - 333333333333
            - 'arn:aws:iam::444444444444:root'
            - Fn::Import: cloudformation-output-arn
      other:
        policy:
          principals: 555555555555

functions:
  function1: # access is not allowed
  function2:
    allowAccess: api # allow access for principals specified in api group only
  function3:
    allowAccess: # allow access for principals specified in both api and other
      - api
      - other
```
