targetScope = 'resourceGroup'

param location string
param tags object
param suffix string
param gatewayImage string
param gatewayIdentityId string
param gatewayClientId string
param sourceAccountName string
param apiKeySecretUri string
param workspaceId string
param appInsightsConnectionString string
param gatewayEntraClientId string = ''
param allowedPrincipalIds array = []
param delegatedAgentClientId string = ''

var baseGatewayConfig = loadTextContent('../../agentgateway/config.yaml')
var entraGatewayConfig = loadTextContent('../../agentgateway/entra.yaml')
var gatewayConfig = empty(gatewayEntraClientId) ? baseGatewayConfig : '${baseGatewayConfig}\n${entraGatewayConfig}'

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-agw-${suffix}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource gateway 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'ca-agw-${suffix}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${gatewayIdentityId}': {}
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
        targetPort: 4000
        transport: 'http'
      }
      secrets: [
        {
          name: 'agentgateway-api-key'
          keyVaultUrl: apiKeySecretUri
          identity: gatewayIdentityId
        }
        {
          name: 'gateway-config'
          // ACA secret volumes also support non-sensitive configuration.
          #disable-next-line use-secure-value-for-secure-inputs
          value: gatewayConfig
        }
        {
          name: 'otel-config'
          #disable-next-line use-secure-value-for-secure-inputs
          value: loadTextContent('../../monitoring/otel-collector.yaml')
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'agentgateway'
          image: gatewayImage
          args: [
            '-f'
            '/etc/agentgateway/config.yaml'
          ]
          env: [
            {
              name: 'AGENTGATEWAY_API_KEY'
              secretRef: 'agentgateway-api-key'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: gatewayClientId
            }
            {
              name: 'SOURCE_AZURE_OPENAI_RESOURCE_NAME'
              value: sourceAccountName
            }
            {
              name: 'AZURE_TENANT_ID'
              value: tenant().tenantId
            }
            {
              name: 'AGENTGATEWAY_ENTRA_CLIENT_ID'
              value: gatewayEntraClientId
            }
            {
              name: 'AGENTGATEWAY_ALLOWED_PRINCIPAL_IDS'
              value: string(allowedPrincipalIds)
            }
            {
              name: 'AGENTGATEWAY_DELEGATED_AGENT_CLIENT_ID'
              value: delegatedAgentClientId
            }
            {
              name: 'AGENTGATEWAY_CONFIG_REVISION'
              value: uniqueString(gatewayConfig)
            }
            {
              name: 'OTEL_SERVICE_NAME'
              value: 'agentgateway-gateway'
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          volumeMounts: [
            {
              volumeName: 'gateway-config'
              mountPath: '/etc/agentgateway'
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/healthz/ready'
                port: 15021
                scheme: 'HTTP'
              }
              periodSeconds: 5
              failureThreshold: 60
            }
            {
              type: 'Liveness'
              tcpSocket: {
                port: 4000
              }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz/ready'
                port: 15021
                scheme: 'HTTP'
              }
              periodSeconds: 10
            }
          ]
        }
        {
          name: 'otel-collector'
          image: 'otel/opentelemetry-collector-contrib:0.162.0'
          args: [
            '--config=/etc/otelcol/config.yaml'
          ]
          env: [
            {
              name: 'AZURE_CLIENT_ID'
              value: gatewayClientId
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsightsConnectionString
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          volumeMounts: [
            {
              volumeName: 'otel-config'
              mountPath: '/etc/otelcol'
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/'
                port: 13133
                scheme: 'HTTP'
              }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/'
                port: 13133
                scheme: 'HTTP'
              }
              periodSeconds: 10
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'gateway-config'
          storageType: 'Secret'
          secrets: [
            {
              secretRef: 'gateway-config'
              path: 'config.yaml'
            }
          ]
        }
        {
          name: 'otel-config'
          storageType: 'Secret'
          secrets: [
            {
              secretRef: 'otel-config'
              path: 'config.yaml'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource environmentDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'shared-monitoring'
  scope: environment
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'ContainerAppConsoleLogs', enabled: true }
      { category: 'ContainerAppSystemLogs', enabled: true }
      { category: 'ContainerAppHTTPLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

resource gatewayDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'shared-monitoring'
  scope: gateway
  properties: {
    workspaceId: workspaceId
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output endpoint string = 'https://${gateway.properties.configuration.ingress.fqdn}'
output name string = gateway.name
