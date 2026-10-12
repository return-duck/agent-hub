package local.agentstack.config;

import local.agentstack.auth.AuthInterceptor;
import local.agentstack.auth.CurrentUserArgumentResolver;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.List;

/**
 * 浏览器只与 server 通信：开发期 web 跑在 5173，因此需要 CORS；
 * 生产部署时通常由同源反向代理收口，这里的白名单是可配置的。
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final AppProperties props;
    private final AuthInterceptor authInterceptor;
    private final CurrentUserArgumentResolver currentUserResolver;

    public WebConfig(AppProperties props, AuthInterceptor authInterceptor,
                     CurrentUserArgumentResolver currentUserResolver) {
        this.props = props;
        this.authInterceptor = authInterceptor;
        this.currentUserResolver = currentUserResolver;
    }

    /**
     * /api/** 默认要求登录；只有注册/登录、公开访问、能力探测除外。
     * 注意 /api/public/** 是给"已发布 agent"的分享页用的，必须免鉴权。
     */
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(authInterceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns(
                        "/api/auth/register",
                        "/api/auth/login",
                        "/api/public/**",
                        "/api/capabilities");
    }

    @Override
    public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
        resolvers.add(currentUserResolver);
    }

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOrigins(props.cors().allowedOrigins().toArray(String[]::new))
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(true);
    }
}
