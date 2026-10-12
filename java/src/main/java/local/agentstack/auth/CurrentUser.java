package local.agentstack.auth;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 标注在 controller 方法参数上，注入当前登录用户。
 *
 * 用法：{@code public Foo list(@CurrentUser AppUser user)}。
 * 实际取值由 AuthInterceptor（校验令牌）与 CurrentUserArgumentResolver（注入）配合完成。
 */
@Target(ElementType.PARAMETER)
@Retention(RetentionPolicy.RUNTIME)
public @interface CurrentUser {
}
