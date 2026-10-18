targetScope = 'resourceGroup'

param location string
param environmentName string
param managedEnvironmentName string
param tenantId string
param spaClientId string
param blueprintClientId string
param hostedAgentId string
param authorizedUserId string
param gatewayClientId string
param foundryEndpoint string
param gatewayEndpoint string
param userScope string = 'access_agent_as_user'
param deployApp bool = false
param image string = ''
param resourceTags object = {}

var suffix = uniqueString(subscription().id, resourceGroup().id, 'copilotkit-demo')
var appName = 'ca-demo-${suffix}'
var tags = union(resourceTags, {
  'azd-env-name': environmentName
  purpose: 'copilotkit-managed-identity-demo'
})

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: managedEnvironmentName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-demo-${suffix}'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acrdemo${suffix}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

var origin = 'https://${appName}.${environment.properties.defaultDomain}'

resource app 'Microsoft.App/containerApps@2025-01-01' = if (deployApp) {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 3000
        transport: 'http'
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'demo'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'DEMO_AUTH_MODE', value: 'managed-identity' }
            { name: 'DEMO_MANAGED_IDENTITY_CLIENT_ID', value: identity.properties.clientId }
            { name: 'DEMO_TENANT_ID', value: tenantId }
            { name: 'DEMO_SPA_CLIENT_ID', value: spaClientId }
            { name: 'DEMO_BLUEPRINT_CLIENT_ID', value: blueprintClientId }
            { name: 'HOSTED_AGENT_PRINCIPAL_ID', value: hostedAgentId }
            { name: 'AZURE_PRINCIPAL_ID', value: authorizedUserId }
            { name: 'AGENTGATEWAY_ENTRA_CLIENT_ID', value: gatewayClientId }
            { name: 'CONSUMER_FOUNDRY_PROJECT_ENDPOINT', value: foundryEndpoint }
            { name: 'AGENTGATEWAY_ENDPOINT', value: gatewayEndpoint }
            { name: 'DEMO_ORIGIN', value: origin }
            { name: 'DEMO_USER_SCOPE', value: userScope }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/api/config'
                port: 3000
              }
              periodSeconds: 10
              failureThreshold: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/config'
                port: 3000
              }
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              tcpSocket: {
                port: 3000
              }
              periodSeconds: 30
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    pullRole
  ]
}

output appName string = appName
output origin string = origin
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output managedIdentityClientId string = identity.properties.clientId
output managedIdentityPrincipalId string = identity.properties.principalId
output managedIdentityId string = identity.id
