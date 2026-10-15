targetScope = 'resourceGroup'

param consumerFoundryName string
param consumerProjectName string
param gatewayEndpoint string
param modelDeploymentName string

@secure()
param gatewayApiKey string

resource account 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: consumerFoundryName
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' existing = {
  parent: account
  name: consumerProjectName
}

resource connection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-04-01-preview' = {
  parent: project
  name: 'agentgateway-gateway'
  properties: {
    category: 'ModelGateway'
    target: '${gatewayEndpoint}/v1'
    authType: 'ApiKey'
    isSharedToAll: false
    credentials: {
      key: gatewayApiKey
    }
    metadata: {
      deploymentInPath: 'false'
      inferenceAPIVersion: ''
      authConfig: string({
        type: 'api_key'
        name: 'Authorization'
        format: 'Bearer {api_key}'
      })
      models: string([
        {
          name: modelDeploymentName
          properties: {
            model: {
              name: 'gpt-5.4-nano'
              version: ''
              format: 'OpenAI'
            }
          }
        }
      ])
    }
  }
}

output name string = connection.name
output modelReference string = '${connection.name}/${modelDeploymentName}'
